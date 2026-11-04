// Orders and tables. Every query that touches an order is limited to the signed-in waiter, so
// another waiter's order looks the same as one that does not exist (no IDOR).
const { AppError } = require("../lib/errors");
const { TABLES, calculateTotals } = require("../lib/domain");
const { nextSequence } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

const OPEN_FILTER = { billed: false, status: { $ne: "Cancelled" } };

function mergeLines(lines) {
  const merged = new Map();
  for (const l of lines) merged.set(l.id, (merged.get(l.id) || 0) + l.qty);
  for (const qty of merged.values()) if (qty > 99) throw new AppError(400, "invalid_input", "Quantity cannot be more than 99.");
  return [...merged].map(([id, qty]) => ({ id, qty }));
}

function createOrderService({ db, catalog }) {
  const orders = db.collection("orders");
  const tables = db.collection("tables");

  const waiterView = (o) => ({
    id: o._id, table: o.table, items: o.items, notes: o.notes, status: o.status, waiter: o.waiter,
    createdAt: o.createdAt, updatedAt: o.updatedAt, billed: o.billed, version: o.version, totals: calculateTotals(o.items)
  });
  // The kitchen needs to cook, not to see prices or who is paying
  const kitchenView = (o) => ({
    id: o._id, table: o.table, items: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty })), notes: o.notes,
    status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt
  });

  // Touching the table's record makes concurrent changes to one table run one after another
  const lockTable = (no, session) => tables.findOneAndUpdate({ _id: no }, { $inc: { rev: 1 } }, { upsert: true, returnDocument: "after", session });

  async function place(req, input, session) {
    const actor = req.auth.user;
    await lockTable(input.table, session);
    const open = await orders.find({ table: input.table, ...OPEN_FILTER }, { session }).toArray();
    if (open.some((o) => o.waiter !== actor.username)) throw new AppError(409, "table_taken", `Table ${input.table} is being served by another waiter.`);

    const { snapshot, stockUsed } = await catalog.reserveStock(mergeLines(input.lines), session);
    const now = new Date();
    const order = {
      _id: `ORD-${await nextSequence(db, "order", 1000, session)}`, table: input.table, items: snapshot, stockUsed, notes: input.notes,
      status: "Placed", waiter: actor.username, createdAt: now, updatedAt: now, billed: false, version: 0
    };
    await orders.insertOne(order, { session });
    await tables.updateOne({ _id: input.table }, { $unset: { billRequestedAt: "" } }, { session });
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Order placed", details: `${order._id} · Table ${order.table}` }, { session });
    return waiterView(order);
  }

  async function ownOrder(req, id, session) {
    const order = await orders.findOne({ _id: id, waiter: req.auth.user.username }, { session });
    if (!order) throw new AppError(404, "not_found", "Order not found.");
    return order;
  }

  async function update(req, id, input, session) {
    const actor = req.auth.user;
    const order = await ownOrder(req, id, session);
    if (order.status !== "Placed") throw new AppError(409, "kitchen_started", `The kitchen has already started ${id}. Send a new order for extra items.`);
    if (order.version !== input.version) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");

    await catalog.releaseStock(order.stockUsed, session);
    const { snapshot, stockUsed } = await catalog.reserveStock(mergeLines(input.lines), session);
    const result = await orders.findOneAndUpdate(
      { _id: id, version: order.version, status: "Placed" },
      { $set: { items: snapshot, stockUsed, notes: input.notes, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: "after", session }
    );
    if (!result) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Order updated", details: `${id} · Table ${order.table}` }, { session });
    return waiterView(result);
  }

  async function transition(id, filter, status, session) {
    return orders.findOneAndUpdate({ _id: id, ...filter }, { $set: { status, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session });
  }

  async function serve(req, id, session) {
    const actor = req.auth.user;
    const order = await ownOrder(req, id, session);
    const result = await transition(id, { status: "Ready", waiter: actor.username }, "Served", session);
    if (!result) throw new AppError(409, "bad_status", `${id} is ${order.status.toLowerCase()}, so it can't be served yet.`);
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Order served", details: `${id} · Table ${order.table}` }, { session });
    return waiterView(result);
  }

  async function cancel(req, id, session) {
    const actor = req.auth.user;
    const order = await ownOrder(req, id, session);
    const result = await transition(id, { status: "Placed", waiter: actor.username }, "Cancelled", session);
    if (!result) throw new AppError(409, "bad_status", `${id} can no longer be cancelled.`);
    await catalog.releaseStock(order.stockUsed, session);
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Order cancelled", details: `${id} · Table ${order.table}`, severity: "warning" }, { session });
    return waiterView(result);
  }

  async function kitchenUpdate(req, id, status, session) {
    const actor = req.auth.user;
    const from = status === "Preparing" ? "Placed" : "Preparing";
    const result = await transition(id, { status: from }, status, session);
    if (!result) {
      const exists = await orders.findOne({ _id: id }, { session });
      throw exists ? new AppError(409, "bad_status", `${id} is already ${exists.status.toLowerCase()}.`) : new AppError(404, "not_found", "Order not found.");
    }
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: `Kitchen: ${status}`, details: `${id} · Table ${result.table}` }, { session });
    return kitchenView(result);
  }

  const kitchenTickets = async () => (await orders.find({ status: { $in: ["Placed", "Preparing", "Ready"] }, billed: false }).sort({ createdAt: 1 }).limit(200).toArray()).map(kitchenView);
  const listOwn = async (username) => (await orders.find({ waiter: username }).sort({ createdAt: -1 }).limit(200).toArray()).map(waiterView);

  // Each waiter sees only that another person holds a table, not what is on it
  async function tableStates(username) {
    const [open, tableDocs] = await Promise.all([orders.find(OPEN_FILTER).toArray(), tables.find().toArray()]);
    const requested = new Map(tableDocs.filter((t) => t.billRequestedAt).map((t) => [t._id, t.billRequestedAt]));
    return TABLES.map((t) => {
      const onTable = open.filter((o) => o.table === t.no);
      const base = { no: t.no, seats: t.seats };
      if (!onTable.length) return { ...base, state: "free", label: "Free" };
      if (onTable.some((o) => o.waiter !== username)) return { ...base, state: "other", label: "Other staff" };
      const orderIds = onTable.map((o) => o._id);
      if (requested.has(t.no)) return { ...base, state: "bill", label: "Bill requested", orderIds };
      if (onTable.some((o) => o.status === "Ready")) return { ...base, state: "ready", label: "Order ready", orderIds };
      if (onTable.every((o) => o.status === "Served")) return { ...base, state: "mine", label: "Served", served: true, orderIds };
      return { ...base, state: "mine", label: "In progress", orderIds };
    });
  }

  async function requestBill(req, no, session) {
    const actor = req.auth.user;
    await lockTable(no, session);
    const open = await orders.find({ table: no, ...OPEN_FILTER }, { session }).toArray();
    if (!open.length || open.some((o) => o.waiter !== actor.username)) throw new AppError(404, "not_found", `There are no open orders of yours on Table ${no}.`);
    if (!open.every((o) => o.status === "Served")) throw new AppError(409, "not_served", `Serve every order on Table ${no} before requesting the bill.`);
    await tables.updateOne({ _id: no }, { $set: { billRequestedAt: new Date() } }, { session });
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Bill requested", details: `Table ${no}` }, { session });
  }

  return { place, update, serve, cancel, kitchenUpdate, kitchenTickets, listOwn, tableStates, requestBill, lockTable, OPEN_FILTER };
}

module.exports = { createOrderService };
