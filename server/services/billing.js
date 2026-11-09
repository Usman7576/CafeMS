// Billing. All amounts come from stored order lines; nothing the browser says about price is used.
const { AppError } = require("../lib/errors");
const { TABLES, DISCOUNT_LIMIT, calculateTotals, maskPhone, dayRange, localDate, localHour } = require("../lib/domain");
const { encrypt, decrypt, blindIndex } = require("../lib/crypto");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");
const { enqueue } = require("./outbox");
const { withTimeout } = require("./gateway");

const OPEN_FOR_PAYMENT = ["Pending Payment", "Payment Failed"];

function createBillingService({ config, db, orderService, approvals, gateway, logger }) {
  const bills = db.collection("bills");
  const orders = db.collection("orders");
  const tables = db.collection("tables");
  const users = db.collection("users");

  // Bills always leave the server masked. Seeing a full number is a separate, logged action.
  const billView = (b) => ({
    no: b._id, table: b.table, orderIds: b.orderIds, lines: b.lines, discountPct: b.discountPct, subtotal: b.subtotal, discount: b.discount,
    tax: b.tax, total: b.total, method: b.method, tendered: b.tendered, change: b.change, cashier: b.cashier, createdAt: b.createdAt,
    status: b.status, phone: b.phoneMask || "", refund: b.refund || null, refundPending: Boolean(b.refundPending)
  });

  function aggregateLines(open) {
    const lines = [];
    for (const o of open) {
      for (const i of o.items) {
        const same = lines.find((l) => l.id === i.id && l.price === i.price);
        if (same) same.qty += i.qty; else lines.push({ id: i.id, name: i.name, price: i.price, qty: i.qty, cat: i.cat });
      }
    }
    return lines;
  }

  async function openTables() {
    const [open, tableDocs, staff] = await Promise.all([
      orders.find(orderService.OPEN_FILTER).toArray(),
      tables.find().toArray(),
      users.find({}, { projection: { username: 1, name: 1 } }).toArray()
    ]);
    const names = new Map(staff.map((u) => [u.username, u.name]));
    return TABLES.map((t) => {
      const onTable = open.filter((o) => o.table === t.no);
      if (!onTable.length) return null;
      const lines = aggregateLines(onTable);
      const doc = tableDocs.find((d) => d._id === t.no);
      return {
        no: t.no, seats: t.seats, lines, totals: calculateTotals(lines), orders: onTable.map((o) => ({ id: o._id, status: o.status })), allServed: onTable.every((o) => o.status === "Served"),
        billRequested: doc && doc.billRequestedAt ? doc.billRequestedAt : null,
        waiters: [...new Set(onTable.map((o) => names.get(o.waiter) || o.waiter))],
        since: new Date(Math.min(...onTable.map((o) => o.createdAt.getTime())))
      };
    }).filter(Boolean);
  }

  async function pay(req, no, input, session) {
    const actor = req.auth.user;
    await orderService.lockTable(no, session);
    const open = await orders.find({ table: no, ...orderService.OPEN_FILTER }, { session }).toArray();
    if (!open.length) throw new AppError(404, "not_found", `Table ${no} has nothing to bill.`);
    if (!open.every((o) => o.status === "Served")) throw new AppError(409, "not_served", `Some orders on Table ${no} haven't been served yet.`);

    const limit = Object.hasOwn(DISCOUNT_LIMIT, actor.role) ? DISCOUNT_LIMIT[actor.role] : 0;
    if (input.discountPct > limit) {
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Access denied", details: `Tried a ${input.discountPct}% discount on Table ${no}`, severity: "warning" });
      throw new AppError(403, "discount_limit", `Your role can apply a discount of up to ${limit}%. Ask a manager for more.`);
    }

    const lines = aggregateLines(open);
    const totals = calculateTotals(lines, input.discountPct);
    let tendered = totals.total;
    if (input.method === "Cash") {
      if (input.tendered === undefined || input.tendered < totals.total) throw new AppError(400, "cash_too_low", `Cash received must be at least Rs ${totals.total.toLocaleString()}.`);
      tendered = input.tendered;
    }

    const billNo = `B-${await nextSequence(db, "bill", 5000, session)}`;
    const bill = {
      _id: billNo, table: no, orderIds: open.map((o) => o._id), lines, discountPct: input.discountPct, subtotal: totals.sub,
      discount: totals.discount, tax: totals.tax, total: totals.total, method: input.method, tendered, change: tendered - totals.total,
      cashier: actor.username, createdAt: new Date(), status: input.method === "Cash" ? "Paid" : "Pending Payment"
    };
    if (input.phone) {
      bill.phoneEnc = encrypt(input.phone, `bill-phone:${billNo}`, config.data);
      bill.phoneIndex = blindIndex(input.phone, config.blindIndexKey);
      bill.phoneMask = maskPhone(input.phone);
    }
    await bills.insertOne(bill, { session });
    await orders.updateMany({ _id: { $in: bill.orderIds } }, { $set: { billed: true, billNo } }, { session });
    await tables.updateOne({ _id: no }, { $unset: { billRequestedAt: "" } }, { session });

    await recordEvent(db, req, {
      actor: actor.username, role: actor.role, action: bill.status === "Paid" ? "Payment recorded" : "Payment started",
      details: `${billNo} · Table ${no} · Rs ${bill.total} · ${bill.method}`
    }, { session });
    if (bill.status === "Paid" && input.phone) await enqueue(db, "receipt", { billNo }, session);
    if (input.discountPct) {
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Discount applied", details: `${billNo} · ${input.discountPct}% (Rs ${bill.discount})`, severity: input.discountPct > 10 ? "high" : "warning" }, { session });
    }
    return billView(bill);
  }

  // Records the gateway's answer. The amount must match the stored bill, whatever the gateway says.
  async function recordGatewayResult(req, no, result, actorName, callbackId) {
    const actor = req.auth ? req.auth.user : { username: actorName, role: "" };
    let mismatch = null;
    let conflict = null;
    return inTransaction(db, async (session) => {
      if (callbackId) await db.collection("gateway_callbacks").insertOne({ _id: callbackId, reference: no, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }, { session });
      const bill = await bills.findOne({ _id: no }, { session });
      if (!bill) throw new AppError(404, "not_found", "Bill not found.");
      if (!OPEN_FOR_PAYMENT.includes(bill.status)) {
        // An approval for a bill that was already settled some other way means the customer may have
        // paid twice. The bill is left as it is, and a person must check and refund the extra payment.
        if (result.status === "approved" && bill.gatewayRef !== result.gatewayRef) {
          conflict = `${no} is already ${bill.status.toLowerCase()} (${bill.method}), but the gateway also approved Rs ${result.amount} (${result.gatewayRef})`;
        }
        return bill;
      }
      if (result.amount !== bill.total) {
        mismatch = `${no}: expected Rs ${bill.total}, gateway reported Rs ${result.amount}`;
        throw new AppError(409, "amount_mismatch", "The gateway reported a different amount, so the payment was not accepted.");
      }
      const status = result.status === "approved" ? "Paid" : "Payment Failed";
      const updated = await bills.findOneAndUpdate(
        { _id: no, status: { $in: OPEN_FOR_PAYMENT } },
        { $set: { status, gatewayRef: result.gatewayRef || null, settledAt: new Date() } },
        { returnDocument: "after", session }
      );
      await recordEvent(db, req, {
        actor: actor.username, role: actor.role, action: status === "Paid" ? "Payment recorded" : "Payment declined",
        details: `${no} · Rs ${bill.total} · ${bill.method}`, severity: status === "Paid" ? "info" : "warning"
      }, { session });
      if (status === "Paid" && bill.phoneEnc) await enqueue(db, "receipt", { billNo: no }, session);
      return updated;
    }).then(async (bill) => {
      if (conflict) await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Payment conflict", details: conflict, severity: "high" });
      return bill;
    }, async (error) => {
      // Written after the rollback, because the record of a refused payment must survive it
      if (mismatch) await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Payment amount mismatch", details: mismatch, severity: "high" });
      throw error;
    });
  }

  // Soft dependency: if the gateway is slow or down, the bill stays Pending Payment and can be retried
  async function settle(req, no) {
    const bill = await bills.findOne({ _id: no });
    if (!bill) throw new AppError(404, "not_found", "Bill not found.");
    if (bill.status !== "Pending Payment") return billView(bill);

    // Only one charge may be in progress, so a double click or quick retry cannot charge twice
    const claimed = await bills.findOneAndUpdate(
      { _id: no, status: "Pending Payment", $or: [{ chargeStartedAt: null }, { chargeStartedAt: { $lt: new Date(Date.now() - config.gateway.timeoutMs * 2) } }] },
      { $set: { chargeStartedAt: new Date() } }
    );
    if (!claimed) return billView(bill);
    const release = () => bills.updateOne({ _id: no }, { $set: { chargeStartedAt: null } });

    let result;
    try {
      result = await withTimeout(gateway.charge({ reference: no, amount: bill.total, method: bill.method }), config.gateway.timeoutMs);
    } catch (error) {
      await release();
      if (logger) logger.warn({ err: error, bill: no }, "Payment gateway unavailable");
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Payment pending", details: `${no}: the gateway did not answer`, severity: "warning" });
      return billView(await bills.findOne({ _id: no }));
    }
    try {
      return billView(await recordGatewayResult(req, no, result));
    } finally {
      await release();
    }
  }

  async function retryPayment(req, no, input) {
    const actor = req.auth.user;
    await inTransaction(db, async (session) => {
      const bill = await bills.findOne({ _id: no }, { session });
      if (!bill) throw new AppError(404, "not_found", "Bill not found.");
      if (!OPEN_FOR_PAYMENT.includes(bill.status)) throw new AppError(409, "not_open", `${no} is not waiting for payment.`);
      // While a card or wallet charge is still waiting for the gateway, taking another payment could
      // charge the customer twice
      if (bill.chargeStartedAt && bill.chargeStartedAt.getTime() > Date.now() - config.gateway.timeoutMs * 2) {
        throw new AppError(409, "charge_in_progress", `A payment for ${no} is still being processed. Wait a few seconds, then check the bill again.`);
      }
      const method = input.method || bill.method;
      if (method === "Cash") {
        if (input.tendered === undefined || input.tendered < bill.total) throw new AppError(400, "cash_too_low", `Cash received must be at least Rs ${bill.total.toLocaleString()}.`);
        await bills.updateOne({ _id: no }, { $set: { status: "Paid", method, tendered: input.tendered, change: input.tendered - bill.total, settledAt: new Date() } }, { session });
        await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Payment recorded", details: `${no} · Rs ${bill.total} · Cash after retry` }, { session });
        if (bill.phoneEnc) await enqueue(db, "receipt", { billNo: no }, session);
      } else {
        await bills.updateOne({ _id: no }, { $set: { status: "Pending Payment", method, tendered: bill.total, change: 0 } }, { session });
      }
    });
    return settle(req, no);
  }

  async function list({ date } = {}) {
    const range = dayRange(date || localDate());
    return (await bills.find({ createdAt: { $gte: range.start, $lt: range.end } }).sort({ createdAt: -1 }).limit(1000).toArray()).map(billView);
  }

  // todayOnly is for roles without report access: an older bill looks the same as one that does not exist
  async function get(no, { todayOnly = false } = {}) {
    const bill = await bills.findOne({ _id: no });
    const today = dayRange(localDate());
    if (!bill || (todayOnly && (bill.createdAt < today.start || bill.createdAt >= today.end))) throw new AppError(404, "not_found", "Bill not found.");
    return billView(bill);
  }

  async function revealPhone(req, no) {
    const bill = await bills.findOne({ _id: no });
    if (!bill) throw new AppError(404, "not_found", "Bill not found.");
    if (!bill.phoneEnc) throw new AppError(404, "not_found", "This bill has no customer number.");
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Customer phone viewed", details: no, severity: "warning" });
    return decrypt(bill.phoneEnc, `bill-phone:${no}`, config.data);
  }

  async function applyRefund(req, no, reason, requestedBy, session) {
    const actor = req.auth.user;
    const refund = { by: requestedBy, at: new Date(), reason, ...(requestedBy === actor.username ? {} : { approvedBy: actor.username }) };
    const updated = await bills.findOneAndUpdate(
      { _id: no, status: "Paid" },
      { $set: { status: "Refunded", refund }, $unset: { refundPending: "" } },
      { returnDocument: "after", session }
    );
    if (!updated) throw new AppError(409, "already_refunded", `${no} has already been refunded.`);
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Refund issued", details: `${no} · Rs ${updated.total} · ${reason}`, severity: "high" }, { session });
    return billView(updated);
  }

  // Separation of privilege: a large refund needs a second person
  async function refund(req, no, reason, session) {
    const actor = req.auth.user;
    const bill = await bills.findOne({ _id: no }, { session });
    if (!bill) throw new AppError(404, "not_found", "Bill not found.");
    if (bill.status === "Refunded") throw new AppError(409, "already_refunded", `${no} has already been refunded.`);
    if (bill.status !== "Paid") throw new AppError(409, "not_paid", `${no} has not been paid, so there is nothing to refund.`);
    if (Date.now() - bill.createdAt.getTime() > config.refundWindowDays * 24 * 60 * 60 * 1000) {
      throw new AppError(409, "refund_window", `Bills can be refunded for ${config.refundWindowDays} days. ${no} is older than that.`);
    }
    if (bill.refundPending) {
      // An approval that expired undecided must not leave the bill stuck
      const live = await db.collection("approvals").findOne({ type: "refund", "payload.no": no, status: "Pending", expiresAt: { $gt: new Date() } }, { session });
      if (live) throw new AppError(409, "refund_pending", `A refund for ${no} is already waiting for approval.`);
      await bills.updateOne({ _id: no }, { $unset: { refundPending: "" } }, { session });
    }

    if (bill.total <= config.refundApprovalLimit) return { status: 200, body: await applyRefund(req, no, reason, actor.username, session) };

    await bills.updateOne({ _id: no, status: "Paid" }, { $set: { refundPending: true } }, { session });
    const approvalId = await approvals.create(req, "refund", { no, reason }, `Refund ${no} · Rs ${bill.total}`, session);
    return { status: 202, body: { approvalId, message: `Refunds over Rs ${config.refundApprovalLimit.toLocaleString()} need a second person to approve.` } };
  }

  // A card or wallet refund must also reach the gateway. It runs after the refund has committed, and only
  // once per bill. If the gateway cannot do it, a person is alerted to return the money by hand.
  async function reversePayment(req, no) {
    const bill = await bills.findOneAndUpdate(
      { _id: no, status: "Refunded", method: { $ne: "Cash" }, "refund.reversalStartedAt": null },
      { $set: { "refund.reversalStartedAt": new Date() } },
      { returnDocument: "after" }
    );
    if (!bill) return;
    const actor = req.auth.user;
    try {
      const result = await withTimeout(Promise.resolve().then(() => gateway.refund({ reference: no, amount: bill.total, gatewayRef: bill.gatewayRef })), config.gateway.timeoutMs);
      await bills.updateOne({ _id: no }, { $set: { "refund.reversedAt": new Date(), "refund.gatewayRef": result.gatewayRef || null } });
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Refund sent to gateway", details: `${no} · Rs ${bill.total}` });
    } catch (error) {
      if (logger) logger.warn({ err: error, bill: no }, "Refund could not reach the gateway");
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Refund reversal failed", details: `${no} · Rs ${bill.total}: return this to the customer by hand`, severity: "high" });
    }
  }

  // Daily paid revenue, oldest first, for the reports trend chart
  async function trend(days = 7) {
    const first = dayRange(localDate(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)).start;
    const rows = await bills.find({ createdAt: { $gte: first }, status: "Paid" }, { projection: { createdAt: 1, total: 1 } }).limit(20000).toArray();
    const totals = new Map();
    for (let i = days - 1; i >= 0; i -= 1) totals.set(localDate(Date.now() - i * 24 * 60 * 60 * 1000), { revenue: 0, bills: 0 });
    for (const b of rows) {
      const day = totals.get(localDate(b.createdAt.getTime()));
      if (day) { day.revenue += b.total; day.bills += 1; }
    }
    return [...totals].map(([date, day]) => ({ date, ...day }));
  }

  async function salesReport(date) {
    const day = date || localDate();
    const range = dayRange(day);
    const rows = await bills.find({ createdAt: { $gte: range.start, $lt: range.end } }, { projection: { phoneEnc: 0, phoneIndex: 0, phoneMask: 0 } }).limit(5000).toArray();
    const paid = rows.filter((b) => b.status === "Paid");
    const refunded = rows.filter((b) => b.status === "Refunded");
    const byHour = new Array(24).fill(0);
    const byMethod = { Cash: 0, Card: 0, Wallet: 0 };
    // A Map, so a category an Admin names "__proto__" or "constructor" is counted like any other
    const byCat = new Map();
    const items = new Map();
    let qty = 0;
    for (const b of paid) {
      byHour[localHour(b.createdAt)] += b.total;
      byMethod[b.method] += b.total;
      for (const l of b.lines) {
        qty += l.qty;
        const cat = l.cat || "Other";
        byCat.set(cat, (byCat.get(cat) || 0) + l.price * l.qty);
        const entry = items.get(l.name) || { name: l.name, qty: 0, revenue: 0 };
        entry.qty += l.qty;
        entry.revenue += l.price * l.qty;
        items.set(l.name, entry);
      }
    }
    const revenue = paid.reduce((s, b) => s + b.total, 0);
    return {
      date: day, revenue, bills: paid.length, avg: paid.length ? Math.round(revenue / paid.length) : 0, items: qty,
      refunds: refunded.length, refundAmount: refunded.reduce((s, b) => s + b.total, 0),
      unpaid: rows.filter((b) => OPEN_FOR_PAYMENT.includes(b.status)).length,
      discounts: paid.reduce((s, b) => s + b.discount, 0), tax: paid.reduce((s, b) => s + b.tax, 0),
      byHour, byMethod, byCat: Object.fromEntries(byCat), top: [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 6)
    };
  }

  return { openTables, pay, settle, retryPayment, recordGatewayResult, list, get, revealPhone, refund, applyRefund, reversePayment, salesReport, trend };
}

module.exports = { createBillingService };
