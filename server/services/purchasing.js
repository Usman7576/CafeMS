// Stock control beyond selling: suppliers, ingredient costs, purchase orders and receiving, stocktakes
// and the waste log. Quantities are in thousandths of a unit and costs in paisa (1/100 rupee) per
// unit, both whole numbers, so repeated sums never drift.
//
// Purchases are made in packs (for example a 1 kg bag, or a crate of 24). A pack's size, in the
// ingredient's own unit, converts what was bought into stock.
const { AppError } = require("../lib/errors");
const { toMilli, fromMilli, dayRange, localDate } = require("../lib/domain");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

const rupees = (paisa) => Math.round(paisa) / 100;
const toPaisa = (rs) => Math.round(rs * 100);
// Value of a quantity (thousandths) at a cost (paisa per unit), in rupees
const valueOf = (qtyMilli, costPaisa) => Math.round((qtyMilli * (costPaisa || 0)) / 1000) / 100;

function createPurchasingService({ db }) {
  const suppliers = db.collection("suppliers");
  const inventory = db.collection("inventory");
  const orders = db.collection("purchase_orders");
  const counts = db.collection("stock_counts");
  const waste = db.collection("waste_log");

  const audit = (req, action, details, session, severity = "info") => recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action, details, severity }, { session });

  // ---------- Suppliers ----------
  const supplierView = (s) => ({ id: s._id, name: s.name, phone: s.phone || "", email: s.email || "", notes: s.notes || "", active: s.active !== false });
  const listSuppliers = async () => (await suppliers.find().sort({ name: 1 }).limit(500).toArray()).map(supplierView);

  async function saveSupplier(req, id, input) {
    return inTransaction(db, async (session) => {
      const clash = await suppliers.findOne({ name: input.name, ...(id ? { _id: { $ne: id } } : {}) }, { session, collation: { locale: "en", strength: 2 } });
      if (clash) throw new AppError(409, "name_taken", "A supplier with this name already exists.");
      if (!id) {
        const doc = { _id: `SUP-${await nextSequence(db, "supplier", 0, session)}`, ...input, createdAt: new Date() };
        await suppliers.insertOne(doc, { session });
        await audit(req, "Supplier added", doc.name, session);
        return supplierView(doc);
      }
      const updated = await suppliers.findOneAndUpdate({ _id: id }, { $set: input }, { returnDocument: "after", session });
      if (!updated) throw new AppError(404, "not_found", "Supplier not found.");
      await audit(req, "Supplier updated", updated.name, session);
      return supplierView(updated);
    });
  }

  // ---------- Ingredients: details, cost and supplier ----------
  async function checkSupplier(id, session) {
    if (id && !(await suppliers.findOne({ _id: id }, { session }))) throw new AppError(400, "invalid_input", "Choose a supplier from the list.");
  }

  async function addIngredient(req, input) {
    return inTransaction(db, async (session) => {
      await checkSupplier(input.supplierId, session);
      if (await inventory.findOne({ name: input.name }, { session, collation: { locale: "en", strength: 2 } })) throw new AppError(409, "name_taken", "An ingredient with this name already exists.");
      const top = await inventory.find({}, { session, projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).toArray();
      const id = await nextSequence(db, "ingredient", top.length ? top[0]._id : 0, session);
      const supplier = input.supplierId ? await suppliers.findOne({ _id: input.supplierId }, { session }) : null;
      const doc = { _id: id, name: input.name, unit: input.unit, qtyMilli: 0, reorderMilli: toMilli(input.reorder), costPaisa: toPaisa(input.cost), supplierId: input.supplierId || null, supplier: supplier ? supplier.name : "" };
      await inventory.insertOne(doc, { session });
      await audit(req, "Ingredient added", `${doc.name} (${doc.unit})`, session);
      return { id };
    });
  }

  async function updateIngredient(req, id, input) {
    return inTransaction(db, async (session) => {
      await checkSupplier(input.supplierId, session);
      const current = await inventory.findOne({ _id: id }, { session });
      if (!current) throw new AppError(404, "not_found", "Ingredient not found.");
      const supplier = input.supplierId ? await suppliers.findOne({ _id: input.supplierId }, { session }) : null;
      const set = { reorderMilli: toMilli(input.reorder), costPaisa: toPaisa(input.cost), supplierId: input.supplierId || null, supplier: supplier ? supplier.name : "" };
      await inventory.updateOne({ _id: id }, { $set: set }, { session });
      if (set.costPaisa !== (current.costPaisa || 0)) await audit(req, "Ingredient cost changed", `${current.name}: Rs ${rupees(current.costPaisa || 0)} to Rs ${rupees(set.costPaisa)} per ${current.unit}`, session, "warning");
      else await audit(req, "Ingredient updated", current.name, session);
      return { id };
    });
  }

  // ---------- Purchase orders ----------
  const poView = (p, names) => ({
    id: p._id, supplierId: p.supplierId, supplier: names.get(p.supplierId) || p.supplierName || "", status: p.status, notes: p.notes || "",
    lines: p.lines.map((l) => ({ ing: l.ing, name: l.name, unit: l.unit, packs: l.packs, packSize: fromMilli(l.packSizeMilli), packCost: rupees(l.packCostPaisa), qty: fromMilli(l.packs * l.packSizeMilli), total: rupees(l.packs * l.packCostPaisa) })),
    received: p.received ? p.received.map((l) => ({ ing: l.ing, name: l.name, packs: l.packs, packCost: rupees(l.packCostPaisa), qty: fromMilli(l.qtyMilli), total: rupees(l.packs * l.packCostPaisa) })) : null,
    total: rupees(p.lines.reduce((s, l) => s + l.packs * l.packCostPaisa, 0)),
    receivedTotal: p.received ? rupees(p.received.reduce((s, l) => s + l.packs * l.packCostPaisa, 0)) : null,
    createdBy: p.createdBy, createdAt: p.createdAt, receivedBy: p.receivedBy || null, receivedAt: p.receivedAt || null
  });

  async function listOrders() {
    const [rows, sups] = await Promise.all([orders.find().sort({ createdAt: -1 }).limit(100).toArray(), suppliers.find().toArray()]);
    const names = new Map(sups.map((s) => [s._id, s.name]));
    return rows.map((p) => poView(p, names));
  }

  async function createOrder(req, input) {
    return inTransaction(db, async (session) => {
      const supplier = await suppliers.findOne({ _id: input.supplierId }, { session });
      if (!supplier || supplier.active === false) throw new AppError(400, "invalid_input", "Choose an active supplier.");
      const ids = input.lines.map((l) => l.ing);
      if (new Set(ids).size !== ids.length) throw new AppError(400, "invalid_input", "Each ingredient can appear only once on an order.");
      const items = await inventory.find({ _id: { $in: ids } }, { session }).toArray();
      if (items.length !== ids.length) throw new AppError(400, "invalid_input", "An order line uses an ingredient that does not exist.");
      const byId = new Map(items.map((i) => [i._id, i]));
      const doc = {
        _id: `PO-${await nextSequence(db, "purchase", 1000, session)}`, supplierId: supplier._id, supplierName: supplier.name, status: "Ordered", notes: input.notes,
        lines: input.lines.map((l) => ({ ing: l.ing, name: byId.get(l.ing).name, unit: byId.get(l.ing).unit, packs: l.packs, packSizeMilli: toMilli(l.packSize), packCostPaisa: toPaisa(l.packCost) })),
        createdBy: req.auth.user.username, createdAt: new Date(), version: 0
      };
      if (doc.lines.some((l) => l.packSizeMilli < 1)) throw new AppError(400, "invalid_input", "Enter how much of the ingredient is in one pack.");
      await orders.insertOne(doc, { session });
      await audit(req, "Purchase order created", `${doc._id} · ${supplier.name} · Rs ${rupees(doc.lines.reduce((s, l) => s + l.packs * l.packCostPaisa, 0))}`, session);
      return poView(doc, new Map([[supplier._id, supplier.name]]));
    });
  }

  // Receiving: what actually arrived, at what price. Stock goes up and each ingredient's cost
  // becomes the weighted average of what was on the shelf and what came in.
  async function receiveOrder(req, id, input) {
    return inTransaction(db, async (session) => {
      const po = await orders.findOne({ _id: id }, { session });
      if (!po) throw new AppError(404, "not_found", "Purchase order not found.");
      if (po.status !== "Ordered") throw new AppError(409, "bad_status", `${id} is already ${po.status.toLowerCase()}.`);
      const got = new Map(input.lines.map((l) => [l.ing, l]));
      if ([...got.keys()].some((ing) => !po.lines.some((l) => l.ing === ing))) throw new AppError(400, "invalid_input", "You can only receive ingredients that are on this order.");
      const received = [];
      for (const line of po.lines) {
        const actual = got.get(line.ing);
        const packs = actual ? actual.packs : line.packs;
        const packCostPaisa = actual && actual.packCost !== undefined ? toPaisa(actual.packCost) : line.packCostPaisa;
        const qtyMilli = packs * line.packSizeMilli;
        received.push({ ing: line.ing, name: line.name, packs, packCostPaisa, qtyMilli });
        if (!qtyMilli) continue;
        const item = await inventory.findOne({ _id: line.ing }, { session });
        if (!item) continue;
        const unitCost = (packCostPaisa * 1000) / line.packSizeMilli;
        const onShelf = Math.max(0, item.qtyMilli);
        const averaged = onShelf > 0 ? Math.round((onShelf * (item.costPaisa || unitCost) + qtyMilli * unitCost) / (onShelf + qtyMilli)) : Math.round(unitCost);
        await inventory.updateOne({ _id: line.ing }, { $inc: { qtyMilli }, $set: { costPaisa: averaged } }, { session });
      }
      const result = await orders.findOneAndUpdate(
        { _id: id, status: "Ordered", version: po.version },
        { $set: { status: "Received", received, receivedBy: req.auth.user.username, receivedAt: new Date() }, $inc: { version: 1 } },
        { returnDocument: "after", session }
      );
      if (!result) throw new AppError(409, "stale_version", `${id} was just changed by someone else.`);
      await audit(req, "Purchase order received", `${id} · ${po.supplierName} · Rs ${rupees(received.reduce((s, l) => s + l.packs * l.packCostPaisa, 0))}`, session);
      return poView(result, new Map([[po.supplierId, po.supplierName]]));
    });
  }

  async function cancelOrder(req, id) {
    return inTransaction(db, async (session) => {
      const result = await orders.findOneAndUpdate({ _id: id, status: "Ordered" }, { $set: { status: "Cancelled", cancelledBy: req.auth.user.username, cancelledAt: new Date() }, $inc: { version: 1 } }, { returnDocument: "after", session });
      if (!result) throw new AppError(409, "bad_status", `${id} cannot be cancelled now.`);
      await audit(req, "Purchase order cancelled", `${id} · ${result.supplierName}`, session, "warning");
      return poView(result, new Map([[result.supplierId, result.supplierName]]));
    });
  }

  // ---------- Stocktake ----------
  // The counted amount replaces what the system thought was there; the difference is recorded with
  // its value, so losses show up in the reports
  async function stocktake(req, input) {
    return inTransaction(db, async (session) => {
      const ids = input.counts.map((c) => c.ing);
      if (new Set(ids).size !== ids.length) throw new AppError(400, "invalid_input", "Each ingredient can be counted only once.");
      const items = await inventory.find({ _id: { $in: ids } }, { session }).toArray();
      if (items.length !== ids.length) throw new AppError(400, "invalid_input", "A count uses an ingredient that does not exist.");
      const byId = new Map(items.map((i) => [i._id, i]));
      const lines = input.counts.map((c) => {
        const item = byId.get(c.ing);
        const countedMilli = toMilli(c.counted);
        const diffMilli = countedMilli - item.qtyMilli;
        return { ing: c.ing, name: item.name, unit: item.unit, expectedMilli: item.qtyMilli, countedMilli, diffMilli, value: valueOf(diffMilli, item.costPaisa) };
      });
      for (const l of lines) await inventory.updateOne({ _id: l.ing }, { $set: { qtyMilli: l.countedMilli } }, { session });
      const doc = { _id: `SC-${await nextSequence(db, "stockcount", 100, session)}`, lines, note: input.note, by: req.auth.user.username, at: new Date(), value: Math.round(lines.reduce((s, l) => s + l.value, 0) * 100) / 100 };
      await counts.insertOne(doc, { session });
      const changed = lines.filter((l) => l.diffMilli !== 0).length;
      await audit(req, "Stocktake recorded", `${doc._id} · ${lines.length} counted · ${changed} differ · Rs ${doc.value}`, session, doc.value < -1000 ? "high" : changed ? "warning" : "info");
      return countView(doc);
    });
  }
  const countView = (c) => ({
    id: c._id, by: c.by, at: c.at, note: c.note || "", value: c.value,
    lines: c.lines.map((l) => ({ ing: l.ing, name: l.name, unit: l.unit, expected: fromMilli(l.expectedMilli), counted: fromMilli(l.countedMilli), diff: fromMilli(l.diffMilli), value: l.value }))
  });
  const listCounts = async () => (await counts.find().sort({ at: -1 }).limit(30).toArray()).map(countView);

  // ---------- Waste log ----------
  async function logWaste(req, input) {
    return inTransaction(db, async (session) => {
      const qtyMilli = toMilli(input.qty);
      const item = await inventory.findOneAndUpdate({ _id: input.ing, qtyMilli: { $gte: qtyMilli } }, { $inc: { qtyMilli: -qtyMilli } }, { returnDocument: "after", session });
      if (!item) {
        const exists = await inventory.findOne({ _id: input.ing }, { session });
        throw exists ? new AppError(409, "stock_too_low", `There is only ${fromMilli(exists.qtyMilli)} ${exists.unit} of ${exists.name} in stock.`) : new AppError(404, "not_found", "Ingredient not found.");
      }
      const doc = { _id: `W-${await nextSequence(db, "waste", 100, session)}`, ing: item._id, name: item.name, unit: item.unit, qtyMilli, reason: input.reason, value: valueOf(qtyMilli, item.costPaisa), by: req.auth.user.username, role: req.auth.user.role, at: new Date() };
      await waste.insertOne(doc, { session });
      await audit(req, "Waste logged", `${item.name} ${fromMilli(qtyMilli)} ${item.unit} · Rs ${doc.value} · ${input.reason}`, session, "warning");
      return wasteView(doc);
    });
  }
  const wasteView = (w) => ({ id: w._id, ing: w.ing, name: w.name, unit: w.unit, qty: fromMilli(w.qtyMilli), reason: w.reason, value: w.value, by: w.by, role: w.role, at: w.at });
  async function listWaste(date) {
    const range = dayRange(date || localDate());
    return (await waste.find({ at: { $gte: range.start, $lt: range.end } }).sort({ at: -1 }).limit(500).toArray()).map(wasteView);
  }

  // A short list for the kitchen and bar: what they may log as waste, without costs or suppliers
  const wasteChoices = async () => (await inventory.find({}, { projection: { name: 1, unit: 1 } }).sort({ name: 1 }).toArray()).map((i) => ({ id: i._id, name: i.name, unit: i.unit }));

  return { listSuppliers, saveSupplier, addIngredient, updateIngredient, listOrders, createOrder, receiveOrder, cancelOrder, stocktake, listCounts, logWaste, listWaste, wasteChoices };
}

module.exports = { createPurchasingService, valueOf, rupees };
