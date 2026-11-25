// Shifts and the cash drawer. A cashier opens a shift with the cash already in the drawer (the float),
// records any cash taken in or out, and closes it by counting the drawer. The Z-report compares the
// count with what the drawer should hold: float + cash taken (including cash tips) + cash in - cash
// out - cash refunded on this shift's bills.
const { AppError } = require("../lib/errors");
const { nextSequence, inTransaction } = require("../lib/tx");
const { dayRange, localDate } = require("../lib/domain");
const { recordEvent } = require("./auditLog");

function createShiftService({ db }) {
  const shifts = db.collection("shifts");
  const bills = db.collection("bills");
  const users = db.collection("users");

  const audit = (req, action, details, session, severity = "info") => recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action, details, severity }, { session });

  // Works out the Z-report from the stored bills, so it always matches what was recorded
  async function report(shift, session) {
    const rows = await bills.find({ shiftId: shift._id }, { session, projection: { phoneEnc: 0, phoneIndex: 0 } }).toArray();
    const paid = rows.filter((b) => b.status === "Paid");
    const refunded = rows.filter((b) => b.status === "Refunded");
    const charge = (b) => b.total + (b.tip || 0);
    const byMethod = { Cash: 0, Card: 0, Wallet: 0, Points: 0 };
    for (const b of paid.concat(refunded)) byMethod[b.method] += charge(b);
    const sum = (list, f) => list.reduce((s, b) => s + f(b), 0);
    const cashIn = sum(shift.movements.filter((m) => m.type === "in"), (m) => m.amount);
    const cashOut = sum(shift.movements.filter((m) => m.type === "out"), (m) => m.amount);
    const cashRefunds = sum(refunded.filter((b) => b.method === "Cash"), charge);
    const expected = shift.float + byMethod.Cash + cashIn - cashOut - cashRefunds;
    const sales = sum(paid, (b) => b.total);
    const counted = shift.status === "Closed" ? shift.counted : null;
    const name = await users.findOne({ username: shift.cashier }, { projection: { name: 1 } });
    return {
      id: shift._id, cashier: shift.cashier, cashierName: name ? name.name : shift.cashier, status: shift.status,
      openedAt: shift.openedAt, closedAt: shift.closedAt || null, float: shift.float,
      bills: paid.length, sales, subtotal: sum(paid, (b) => b.subtotal), discounts: sum(paid, (b) => b.discount),
      service: sum(paid, (b) => b.service || 0), tax: sum(paid, (b) => b.tax), tips: sum(paid, (b) => b.tip || 0),
      byMethod, refunds: refunded.length, refundAmount: sum(refunded, charge), cashRefunds,
      unpaid: rows.filter((b) => b.status === "Pending Payment" || b.status === "Payment Failed").length,
      cashIn, cashOut, movements: shift.movements, expected, counted,
      overShort: counted === null ? null : counted - expected, note: shift.note || ""
    };
  }

  const current = (username, session) => shifts.findOne({ cashier: username, status: "Open" }, { session });

  async function mine(req) {
    const shift = await current(req.auth.user.username);
    return shift ? report(shift) : null;
  }

  async function open(req, float) {
    const actor = req.auth.user;
    return inTransaction(db, async (session) => {
      if (await current(actor.username, session)) throw new AppError(409, "shift_open", "Your shift is already open.");
      const shift = { _id: `S-${await nextSequence(db, "shift", 100, session)}`, cashier: actor.username, status: "Open", float, movements: [], openedAt: new Date() };
      try {
        await shifts.insertOne(shift, { session });
      } catch (error) {
        // Two clicks at once: the unique index lets only one shift open
        if (error.code === 11000) throw new AppError(409, "shift_open", "Your shift is already open.");
        throw error;
      }
      await audit(req, "Shift opened", `${shift._id} · float Rs ${float}`, session);
      return report(shift, session);
    });
  }

  async function move(req, input) {
    const actor = req.auth.user;
    return inTransaction(db, async (session) => {
      const shift = await current(actor.username, session);
      if (!shift) throw new AppError(409, "no_shift", "Open your shift first.");
      if (input.type === "out") {
        const now = await report(shift, session);
        if (input.amount > now.expected) throw new AppError(409, "drawer_short", `The drawer should only hold Rs ${now.expected.toLocaleString()}.`);
      }
      const movement = { type: input.type, amount: input.amount, reason: input.reason, at: new Date() };
      const updated = await shifts.findOneAndUpdate({ _id: shift._id, status: "Open" }, { $push: { movements: movement } }, { returnDocument: "after", session });
      await audit(req, input.type === "in" ? "Cash added to drawer" : "Cash taken from drawer", `${shift._id} · Rs ${input.amount} · ${input.reason}`, session, input.type === "out" ? "warning" : "info");
      return report(updated, session);
    });
  }

  async function close(req, counted, note) {
    const actor = req.auth.user;
    let result;
    await inTransaction(db, async (session) => {
      const shift = await current(actor.username, session);
      if (!shift) throw new AppError(409, "no_shift", "There is no open shift to close.");
      const before = await report(shift, session);
      if (before.unpaid) throw new AppError(409, "unpaid_bills", `${before.unpaid} bill${before.unpaid === 1 ? " is" : "s are"} still waiting for payment. Settle or retry ${before.unpaid === 1 ? "it" : "them"} first.`);
      const updated = await shifts.findOneAndUpdate(
        { _id: shift._id, status: "Open" },
        { $set: { status: "Closed", closedAt: new Date(), counted, expected: before.expected, overShort: counted - before.expected, note } },
        { returnDocument: "after", session }
      );
      const diff = counted - before.expected;
      await audit(req, "Shift closed", `${shift._id} · counted Rs ${counted} · expected Rs ${before.expected} · ${diff === 0 ? "balanced" : diff > 0 ? `over Rs ${diff}` : `short Rs ${-diff}`}`, session, Math.abs(diff) > 500 ? "high" : diff ? "warning" : "info");
      result = await report(updated, session);
    });
    return result;
  }

  async function list(date) {
    const range = dayRange(date || localDate());
    const rows = await shifts.find({ openedAt: { $gte: range.start, $lt: range.end } }).sort({ openedAt: -1 }).limit(200).toArray();
    return Promise.all(rows.map((s) => report(s)));
  }

  async function get(id) {
    const shift = await shifts.findOne({ _id: id });
    if (!shift) throw new AppError(404, "not_found", "Shift not found.");
    return report(shift);
  }

  return { mine, open, move, close, list, get, current };
}

module.exports = { createShiftService };
