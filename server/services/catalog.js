// Menu and stock. Availability is always worked out here, never trusted from a client.
const { AppError } = require("../lib/errors");
const { fromMilli, toMilli } = require("../lib/domain");
const { nextSequence } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

function createCatalogService({ db }) {
  const menu = db.collection("menu");
  const inventory = db.collection("inventory");

  const stockStatus = (ing) => (ing.qtyMilli <= 0 ? "out" : ing.qtyMilli <= ing.reorderMilli ? "low" : "ok");

  function unavailableReason(item, stock) {
    if (!item.available) return "Switched off";
    const short = (item.recipe || []).find((r) => {
      const ing = stock.get(r.ing);
      return !ing || ing.qtyMilli < r.qtyMilli;
    });
    if (!short) return null;
    const ing = stock.get(short.ing);
    return ing ? `Out of ${ing.name.toLowerCase()}` : "Unavailable";
  }

  async function stockMap(session) {
    const rows = await inventory.find({}, { session }).toArray();
    return new Map(rows.map((r) => [r._id, r]));
  }

  // Waiters see what they need to sell an item; recipes and stock levels stay private
  async function listForSale() {
    const [items, stock] = await Promise.all([menu.find().sort({ _id: 1 }).toArray(), stockMap()]);
    return items.map((m) => ({ id: m._id, name: m.name, cat: m.cat, price: m.price, desc: m.desc, available: !unavailableReason(m, stock), reason: unavailableReason(m, stock) }));
  }

  async function listForAdmin() {
    const [items, stock] = await Promise.all([menu.find().sort({ _id: 1 }).toArray(), stockMap()]);
    return items.map((m) => ({ id: m._id, name: m.name, cat: m.cat, price: m.price, desc: m.desc, available: m.available, reason: unavailableReason(m, stock) }));
  }

  const inventoryView = (ing, usedIn) => ({
    id: ing._id, name: ing.name, unit: ing.unit, qty: fromMilli(ing.qtyMilli), reorder: fromMilli(ing.reorderMilli),
    supplier: ing.supplier, status: stockStatus(ing), usedIn
  });

  async function listInventory() {
    const [rows, items] = await Promise.all([inventory.find().sort({ _id: 1 }).toArray(), menu.find().toArray()]);
    return rows.map((ing) => inventoryView(ing, items.filter((m) => (m.recipe || []).some((r) => r.ing === ing._id)).map((m) => m.name)));
  }

  // Takes the stock an order needs. Each update only succeeds if enough remains, so stock can
  // never go negative and two orders cannot both take the last portion.
  async function reserveStock(lines, session) {
    const ids = lines.map((l) => l.id);
    const found = await menu.find({ _id: { $in: ids } }, { session }).toArray();
    const items = new Map(found.map((m) => [m._id, m]));
    const needed = new Map();

    const snapshot = lines.map((l) => {
      const item = items.get(l.id);
      if (!item) throw new AppError(409, "item_unavailable", "An item on this order is no longer on the menu.");
      if (!item.available) throw new AppError(409, "item_unavailable", `${item.name} is no longer available.`);
      for (const r of item.recipe || []) needed.set(r.ing, (needed.get(r.ing) || 0) + r.qtyMilli * l.qty);
      return { id: item._id, name: item.name, price: item.price, qty: l.qty, cat: item.cat };
    });

    for (const [ing, qtyMilli] of needed) {
      const result = await inventory.updateOne({ _id: ing, qtyMilli: { $gte: qtyMilli } }, { $inc: { qtyMilli: -qtyMilli } }, { session });
      if (result.modifiedCount !== 1) {
        const short = lines.map((l) => items.get(l.id)).find((m) => (m.recipe || []).some((r) => r.ing === ing));
        throw new AppError(409, "item_unavailable", `There is not enough stock for ${short.name}.`);
      }
    }
    return { snapshot, stockUsed: [...needed].map(([ing, qtyMilli]) => ({ ing, qtyMilli })) };
  }

  // Returns exactly what the order took, even if the recipe has changed since
  async function releaseStock(stockUsed, session) {
    for (const { ing, qtyMilli } of stockUsed || []) {
      await inventory.updateOne({ _id: ing }, { $inc: { qtyMilli } }, { session });
    }
  }

  async function saveItem(req, id, data, session) {
    const actor = req.auth.user;
    const event = (action, details, severity) => recordEvent(db, req, { actor: actor.username, role: actor.role, action, details, severity }, { session });

    // A case-insensitive comparison that treats the name purely as text
    const duplicate = await menu.findOne(
      { name: data.name, ...(id ? { _id: { $ne: id } } : {}) },
      { session, collation: { locale: "en", strength: 2 } }
    );
    if (duplicate) throw new AppError(409, "name_taken", "An item with this name already exists.");

    if (!id) {
      const newId = await nextSequence(db, "menu", 0, session);
      await menu.insertOne({ _id: newId, ...data, recipe: [] }, { session });
      await event("Menu item added", `${data.name} · ${data.cat} · Rs ${data.price}`, "warning");
      return newId;
    }

    const current = await menu.findOne({ _id: id }, { session });
    if (!current) throw new AppError(404, "not_found", "Item not found.");
    if (current.price !== data.price) await event("Price changed", `${current.name}: Rs ${current.price} to Rs ${data.price}`, "warning");
    if (current.available !== data.available) await event(data.available ? "Item switched on" : "Item switched off", data.name, "info");
    if (current.name !== data.name || current.cat !== data.cat || current.desc !== data.desc) await event("Menu item edited", data.name, "info");
    await menu.updateOne({ _id: id }, { $set: data }, { session });
    return id;
  }

  async function deleteItem(req, id, session) {
    const item = await menu.findOne({ _id: id }, { session });
    if (!item) throw new AppError(404, "not_found", "Item not found.");
    const inUse = await db.collection("orders").findOne({ billed: false, status: { $ne: "Cancelled" }, "items.id": id }, { session });
    if (inUse) throw new AppError(409, "item_in_use", "This item is on an open order. Remove it after the table has paid.");
    await menu.deleteOne({ _id: id }, { session });
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Menu item deleted", details: `${item.name} · Rs ${item.price}`, severity: "high" }, { session });
  }

  async function adjustStock(req, id, delta, reason, session) {
    const deltaMilli = toMilli(delta);
    if (deltaMilli === 0) throw new AppError(400, "invalid_input", "Enter a quantity between 0 and 1000.");
    const filter = deltaMilli < 0 ? { _id: id, qtyMilli: { $gte: -deltaMilli } } : { _id: id };
    const updated = await inventory.findOneAndUpdate(filter, { $inc: { qtyMilli: deltaMilli } }, { returnDocument: "after", session });
    if (!updated) {
      const exists = await inventory.findOne({ _id: id }, { session });
      throw exists ? new AppError(409, "stock_too_low", "Stock can't go below zero.") : new AppError(404, "not_found", "Item not found.");
    }
    await recordEvent(db, req, {
      actor: req.auth.user.username, role: req.auth.user.role,
      action: delta > 0 ? "Stock restocked" : "Stock written off",
      details: `${updated.name} ${delta > 0 ? "+" : ""}${delta} ${updated.unit} · ${reason}`,
      severity: delta > 0 ? "info" : "warning"
    }, { session });
    return inventoryView(updated);
  }

  return { listForSale, listForAdmin, listInventory, reserveStock, releaseStock, saveItem, deleteItem, adjustStock };
}

module.exports = { createCatalogService };
