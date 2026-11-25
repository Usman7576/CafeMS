// Orders and tables. Every query that touches an order is limited to the person who took it, so
// another person's order looks the same as one that does not exist (no IDOR).
//
// An order is dine-in (at a table), takeaway or delivery. It can be held (saved, not yet sent) and
// is then sent to the stations. Each station (Kitchen, Bar) prepares its own part and keeps its
// own status; the order is Ready when every station is ready.
const { AppError } = require("../lib/errors");
const { calculateTotals, maskPhone } = require("../lib/domain");
const { encrypt, decrypt } = require("../lib/crypto");
const { nextSequence } = require("../lib/tx");
const { recordEvent } = require("./auditLog");
const { STATION_OF } = require("../lib/permissions");

const OPEN_FILTER = { billed: false, status: { $ne: "Cancelled" } };
const SENT = ["Placed", "Preparing", "Ready"];
const TYPE_LABEL = Object.freeze({ "dine-in": "Dine-in", takeaway: "Takeaway", delivery: "Delivery" });

// Lines for the same item with the same options become one line
function mergeLines(lines) {
  const merged = new Map();
  for (const l of lines) {
    const options = [...(l.options || [])].sort((a, b) => `${a.group}\u0000${a.choice}`.localeCompare(`${b.group}\u0000${b.choice}`));
    const key = JSON.stringify([l.id, options]);
    const current = merged.get(key);
    merged.set(key, { id: l.id, options, qty: (current ? current.qty : 0) + l.qty });
  }
  for (const l of merged.values()) if (l.qty > 99) throw new AppError(400, "invalid_input", "Quantity cannot be more than 99.");
  return [...merged.values()];
}

// Orders from before stations existed are treated as kitchen-only
function stationsOf(o) {
  if (o.stations) return o.stations;
  return SENT.includes(o.status) ? { Kitchen: o.status } : {};
}

const stationsFor = (items) => Object.fromEntries([...new Set(items.map((i) => i.station || "Kitchen"))].map((s) => [s, "Placed"]));

// The order as a whole: Ready when every station is ready, Preparing once any has started
function overallStatus(stations) {
  const values = Object.values(stations);
  if (values.length && values.every((v) => v === "Ready")) return "Ready";
  if (values.some((v) => v !== "Placed")) return "Preparing";
  return "Placed";
}

function createOrderService({ config, db, catalog, settings }) {
  const orders = db.collection("orders");
  const tables = db.collection("tables");

  const typeOf = (o) => o.type || "dine-in";
  const labelOf = (o) => (typeOf(o) === "dine-in" ? `Table ${o.table}` : `${TYPE_LABEL[typeOf(o)]} · ${o.customer ? o.customer.name : ""}`);
  const customerView = (o) => {
    if (!o.customer) return null;
    const address = o.customer.addressEnc ? decrypt(o.customer.addressEnc, `order-address:${o._id}`, config.data) : "";
    return { name: o.customer.name, phone: o.customer.phoneMask || "", address };
  };

  const waiterView = (o) => ({
    id: o._id, type: typeOf(o), table: o.table, label: labelOf(o), customer: customerView(o), items: o.items, notes: o.notes,
    status: o.status, stations: stationsOf(o), waiter: o.waiter, createdAt: o.createdAt, updatedAt: o.updatedAt, billed: o.billed,
    billNo: o.billNo || null, version: o.version, totals: calculateTotals(o.items, 0, settings.taxRate())
  });
  // A station needs to cook, not to see prices or who is paying: only its own items, the table or the
  // customer's first name, and its own status
  const stationView = (o, station) => ({
    id: o._id, type: typeOf(o), table: o.table, label: typeOf(o) === "dine-in" ? `Table ${o.table}` : `${TYPE_LABEL[typeOf(o)]} · ${o.customer ? o.customer.name.split(" ")[0] : ""}`,
    items: o.items.filter((i) => (i.station || "Kitchen") === station).map((i) => ({ id: i.id, name: i.name, qty: i.qty, options: i.options || [] })),
    notes: o.notes, status: stationsOf(o)[station], createdAt: o.createdAt, updatedAt: o.updatedAt
  });

  // Touching the table's record makes concurrent changes to one table run one after another
  const lockTable = (no, session) => tables.findOneAndUpdate({ _id: no }, { $inc: { rev: 1 } }, { upsert: true, returnDocument: "after", session });
  const audit = (req, action, details, session, severity = "info") => recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action, details, severity }, { session });

  async function place(req, input, session) {
    const actor = req.auth.user;
    if (!settings.typeAllowed(input.type)) throw new AppError(400, "invalid_input", `${TYPE_LABEL[input.type]} orders are switched off in Settings.`);
    if (input.type === "dine-in") {
      if (!settings.hasTable(input.table)) throw new AppError(400, "invalid_input", "Choose a valid table.");
      await lockTable(input.table, session);
      const open = await orders.find({ table: input.table, ...OPEN_FILTER }, { session }).toArray();
      if (open.some((o) => o.waiter !== actor.username)) throw new AppError(409, "table_taken", `Table ${input.table} is being served by someone else.`);
    }

    const { snapshot, stockUsed } = await catalog.reserveStock(mergeLines(input.lines), session);
    const now = new Date();
    const id = `ORD-${await nextSequence(db, "order", 1000, session)}`;
    const order = {
      _id: id, type: input.type, table: input.type === "dine-in" ? input.table : null, items: snapshot, stockUsed, notes: input.notes,
      status: input.hold ? "Held" : "Placed", stations: input.hold ? {} : stationsFor(snapshot),
      waiter: actor.username, createdAt: now, updatedAt: now, billed: false, version: 0
    };
    // Customer details are kept only for takeaway and delivery; the phone and address are encrypted
    if (input.type !== "dine-in") {
      const c = input.customer;
      order.customer = { name: c.name };
      if (c.phone) { order.customer.phoneEnc = encrypt(c.phone, `order-phone:${id}`, config.data); order.customer.phoneMask = maskPhone(c.phone); }
      if (c.address) order.customer.addressEnc = encrypt(c.address, `order-address:${id}`, config.data);
    }
    await orders.insertOne(order, { session });
    if (order.table) await tables.updateOne({ _id: order.table }, { $unset: { billRequestedAt: "" } }, { session });
    await audit(req, input.hold ? "Order held" : "Order placed", `${id} · ${labelOf(order)}`, session);
    return waiterView(order);
  }

  async function ownOrder(req, id, session) {
    const order = await orders.findOne({ _id: id, waiter: req.auth.user.username }, { session });
    if (!order) throw new AppError(404, "not_found", "Order not found.");
    return order;
  }

  // Changes are allowed while the order is held, or sent but not yet started by any station
  const notStarted = (o) => o.status === "Held" || (o.status === "Placed" && Object.values(stationsOf(o)).every((s) => s === "Placed"));

  async function update(req, id, input, session) {
    const order = await ownOrder(req, id, session);
    if (!notStarted(order)) throw new AppError(409, "kitchen_started", `Preparation of ${id} has already started. Send a new order for extra items.`);
    if (order.version !== input.version) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");

    await catalog.releaseStock(order.stockUsed, session);
    const { snapshot, stockUsed } = await catalog.reserveStock(mergeLines(input.lines), session);
    const stations = order.status === "Held" ? {} : stationsFor(snapshot);
    const result = await orders.findOneAndUpdate(
      { _id: id, version: order.version, status: order.status },
      { $set: { items: snapshot, stockUsed, stations, notes: input.notes, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: "after", session }
    );
    if (!result) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");
    await audit(req, "Order updated", `${id} · ${labelOf(order)}`, session);
    return waiterView(result);
  }

  // A held order goes to the stations
  async function send(req, id, session) {
    const order = await ownOrder(req, id, session);
    const result = await orders.findOneAndUpdate({ _id: id, status: "Held" }, { $set: { status: "Placed", stations: stationsFor(order.items), updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session });
    if (!result) throw new AppError(409, "bad_status", `${id} has already been sent.`);
    await audit(req, "Order sent", `${id} · ${labelOf(order)}`, session);
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
    await audit(req, typeOf(order) === "dine-in" ? "Order served" : "Order handed over", `${id} · ${labelOf(order)}`, session);
    return waiterView(result);
  }

  // The person who took it can cancel an order until a station starts on it
  async function cancel(req, id, session) {
    const order = await ownOrder(req, id, session);
    if (!notStarted(order)) throw new AppError(409, "bad_status", `${id} can no longer be cancelled. Ask a manager to void it.`);
    const result = await orders.findOneAndUpdate({ _id: id, version: order.version, status: order.status }, { $set: { status: "Cancelled", updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session });
    if (!result) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");
    await catalog.releaseStock(order.stockUsed, session);
    await audit(req, "Order cancelled", `${id} · ${labelOf(order)}`, session, "warning");
    return waiterView(result);
  }

  // A manager voids an order that has already been started or served, with a reason. Stock a
  // station has started on is counted as used, so it is not returned.
  async function voidOrder(req, id, reason, session) {
    const order = await orders.findOne({ _id: id, ...OPEN_FILTER }, { session });
    if (!order) throw new AppError(404, "not_found", "There is no open order with that number.");
    const result = await orders.findOneAndUpdate(
      { _id: id, version: order.version, ...OPEN_FILTER },
      { $set: { status: "Cancelled", voided: { by: req.auth.user.username, reason, at: new Date(), from: order.status }, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: "after", session }
    );
    if (!result) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");
    const returned = notStarted(order);
    if (returned) await catalog.releaseStock(order.stockUsed, session);
    if (order.table) await tables.updateOne({ _id: order.table }, { $unset: { billRequestedAt: "" } }, { session });
    await audit(req, "Order voided", `${id} · ${labelOf(order)} · was ${order.status} · ${reason}${returned ? "" : " · stock counted as used"}`, session, "high");
    return { id, status: "Cancelled", stockReturned: returned };
  }

  // Moves one dine-in order to another table that is free or already the same person's
  async function transfer(req, id, to, session) {
    const actor = req.auth.user;
    const order = await ownOrder(req, id, session);
    if (typeOf(order) !== "dine-in" || order.billed || order.status === "Cancelled") throw new AppError(409, "bad_status", `${id} cannot be moved.`);
    if (order.table === to) throw new AppError(400, "invalid_input", `${id} is already on Table ${to}.`);
    if (!settings.hasTable(to)) throw new AppError(400, "invalid_input", "Choose a valid table.");
    // Both tables are locked, always lowest number first, so two moves cannot deadlock
    for (const no of [order.table, to].sort((a, b) => a - b)) await lockTable(no, session);
    const there = await orders.find({ table: to, ...OPEN_FILTER }, { session }).toArray();
    if (there.some((o) => o.waiter !== actor.username)) throw new AppError(409, "table_taken", `Table ${to} is being served by someone else.`);
    const result = await orders.findOneAndUpdate({ _id: id, version: order.version }, { $set: { table: to, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session });
    if (!result) throw new AppError(409, "stale_version", "This order changed on another screen. Reload and try again.");
    await tables.updateMany({ _id: { $in: [order.table, to] } }, { $unset: { billRequestedAt: "" } }, { session });
    await audit(req, "Order moved", `${id} · Table ${order.table} to Table ${to}`, session);
    return waiterView(result);
  }

  // Each display role moves only its own station's part of an order
  async function kitchenUpdate(req, id, status, session) {
    const station = STATION_OF[req.auth.user.role];
    const from = status === "Preparing" ? "Placed" : "Preparing";
    const current = await orders.findOne({ _id: id, billed: false, status: { $in: SENT } }, { session });
    if (!current || !stationsOf(current)[station]) throw new AppError(404, "not_found", "Ticket not found.");
    const stations = stationsOf(current);
    if (stations[station] !== from) throw new AppError(409, "bad_status", `${id} is already ${stations[station].toLowerCase()} at the ${station.toLowerCase()}.`);
    const next = { ...stations, [station]: status };
    const result = await orders.findOneAndUpdate(
      { _id: id, version: current.version },
      { $set: { stations: next, status: overallStatus(next), updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: "after", session }
    );
    if (!result) throw new AppError(409, "stale_version", "This ticket just changed. Try again.");
    await audit(req, `${station}: ${status}`, `${id} · ${labelOf(result)}`, session);
    return stationView(result, station);
  }

  // Tickets stay on the display until the order is served or handed over
  async function kitchenTickets(role) {
    const station = STATION_OF[role];
    const open = await orders.find({ status: { $in: SENT }, billed: false }).sort({ createdAt: 1 }).limit(200).toArray();
    return open.filter((o) => stationsOf(o)[station]).map((o) => stationView(o, station));
  }
  const listOwn = async (username) => (await orders.find({ waiter: username }).sort({ createdAt: -1 }).limit(200).toArray()).map(waiterView);

  // Each person sees only that someone else holds a table, not what is on it
  async function tableStates(username) {
    const [open, tableDocs] = await Promise.all([orders.find({ ...OPEN_FILTER, table: { $ne: null } }).toArray(), tables.find().toArray()]);
    const requested = new Map(tableDocs.filter((t) => t.billRequestedAt).map((t) => [t._id, t.billRequestedAt]));
    return settings.get().tables.map((t) => {
      const onTable = open.filter((o) => o.table === t.no);
      const base = { no: t.no, seats: t.seats, area: t.area };
      if (!onTable.length) return { ...base, state: "free", label: "Free" };
      if (onTable.some((o) => o.waiter !== username)) return { ...base, state: "other", label: "Other staff" };
      const orderIds = onTable.map((o) => o._id);
      if (requested.has(t.no)) return { ...base, state: "bill", label: "Bill requested", orderIds };
      if (onTable.some((o) => o.status === "Ready")) return { ...base, state: "ready", label: "Order ready", orderIds };
      if (onTable.every((o) => o.status === "Served")) return { ...base, state: "mine", label: "Served", served: true, orderIds };
      if (onTable.every((o) => o.status === "Held")) return { ...base, state: "mine", label: "On hold", orderIds };
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
    await audit(req, "Bill requested", `Table ${no}`, session);
  }

  return { place, update, send, serve, cancel, voidOrder, transfer, kitchenUpdate, kitchenTickets, listOwn, tableStates, requestBill, lockTable, labelOf, typeOf, OPEN_FILTER };
}

module.exports = { createOrderService, overallStatus, mergeLines };
