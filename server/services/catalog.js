// Menu and stock. Availability is always worked out here, never trusted from a client.
const { AppError } = require("../lib/errors");
const { fromMilli, toMilli } = require("../lib/domain");
const { nextSequence } = require("../lib/tx");
const { recordEvent } = require("./auditLog");
const { enqueue } = require("./outbox");

// Works out the options chosen for one line from the item's own option groups. Names are matched
// exactly; the price of each choice comes from the menu, never from the request.
function resolveOptions(item, chosen) {
  const groups = item.options || [];
  const picked = new Map();
  for (const c of chosen || []) {
    const group = groups.find((g) => g.name === c.group);
    const choice = group && group.choices.find((x) => x.name === c.choice);
    if (!choice) throw new AppError(400, "invalid_option", `"${c.choice}" is not an option for ${item.name}.`);
    const list = picked.get(group.name) || [];
    if (list.some((x) => x.name === choice.name)) throw new AppError(400, "invalid_option", `"${choice.name}" was chosen twice for ${item.name}.`);
    if (!group.multi && list.length) throw new AppError(400, "invalid_option", `Choose one ${group.name.toLowerCase()} for ${item.name}.`);
    picked.set(group.name, [...list, choice]);
  }
  const missing = groups.find((g) => g.required && !picked.has(g.name));
  if (missing) throw new AppError(400, "invalid_option", `Choose a ${missing.name.toLowerCase()} for ${item.name}.`);
  // Listed in the menu's own order, so the same choices always give the same line
  const labels = [];
  const chosenList = [];
  let extra = 0;
  for (const g of groups) for (const ch of g.choices) {
    if ((picked.get(g.name) || []).includes(ch)) { labels.push(ch.name); chosenList.push({ group: g.name, choice: ch.name }); extra += ch.price; }
  }
  return { labels, chosen: chosenList, extra };
}

function createCatalogService({ db, settings }) {
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
    return items.map((m) => ({ id: m._id, name: m.name, cat: m.cat, station: settings.stationOf(m.cat), price: m.price, desc: m.desc, options: m.options || [], hasPhoto: Boolean(m.photo), available: !unavailableReason(m, stock), reason: unavailableReason(m, stock) }));
  }

  async function listForAdmin() {
    const [items, stock] = await Promise.all([menu.find().sort({ _id: 1 }).toArray(), stockMap()]);
    return items.map((m) => ({ id: m._id, name: m.name, cat: m.cat, station: settings.stationOf(m.cat), price: m.price, desc: m.desc, options: m.options || [], hasPhoto: Boolean(m.photo), available: m.available, cost: recipeCost(m, stock), margin: m.price ? Math.round(((m.price - recipeCost(m, stock)) / m.price) * 1000) / 10 : 0, reason: unavailableReason(m, stock), recipe: (m.recipe || []).map((r) => ({ ing: r.ing, qty: fromMilli(r.qtyMilli), name: stock.has(r.ing) ? stock.get(r.ing).name : "Unknown" })) }));
  }

  const inventoryView = (ing, usedIn) => ({
    id: ing._id, name: ing.name, unit: ing.unit, qty: fromMilli(ing.qtyMilli), reorder: fromMilli(ing.reorderMilli),
    supplier: ing.supplier, supplierId: ing.supplierId || "", cost: (ing.costPaisa || 0) / 100,
    value: Math.round((Math.max(0, ing.qtyMilli) * (ing.costPaisa || 0)) / 1000) / 100, status: stockStatus(ing), usedIn
  });

  // What one portion costs in ingredients, from the current average costs
  const recipeCost = (m, stock) => Math.round((m.recipe || []).reduce((s, r) => s + (r.qtyMilli * ((stock.get(r.ing) || {}).costPaisa || 0)) / 1000, 0)) / 100;

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
      const { labels, chosen, extra } = resolveOptions(item, l.options);
      return { id: item._id, name: item.name, price: item.price + extra, qty: l.qty, cat: item.cat, station: settings.stationOf(item.cat), options: labels, chosen };
    });

    for (const [ing, qtyMilli] of needed) {
      const updated = await inventory.findOneAndUpdate({ _id: ing, qtyMilli: { $gte: qtyMilli } }, { $inc: { qtyMilli: -qtyMilli } }, { returnDocument: "after", session });
      if (updated) await notifyIfCrossedReorder(updated, qtyMilli, session);
      else {
        const short = lines.map((l) => items.get(l.id)).find((m) => (m.recipe || []).some((r) => r.ing === ing));
        throw new AppError(409, "item_unavailable", `There is not enough stock for ${short.name}.`);
      }
    }
    return { snapshot, stockUsed: [...needed].map(([ing, qtyMilli]) => ({ ing, qtyMilli })) };
  }

  // Only the moment stock falls to its reorder level sends a message, not every order after it
  async function notifyIfCrossedReorder(ing, removedMilli, session) {
    if (ing.qtyMilli <= ing.reorderMilli && ing.qtyMilli + removedMilli > ing.reorderMilli) {
      await enqueue(db, "low-stock", { ingredient: ing.name }, session);
    }
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

    // Each ingredient must exist and appear once; stored in thousandths, like stock
    let recipe;
    if (data.recipe) {
      const ids = data.recipe.map((r) => r.ing);
      if (new Set(ids).size !== ids.length) throw new AppError(400, "invalid_input", "Each ingredient can appear only once in a recipe.");
      if (await inventory.countDocuments({ _id: { $in: ids } }, { session }) !== ids.length) throw new AppError(400, "invalid_input", "A recipe uses an ingredient that does not exist.");
      recipe = data.recipe.map((r) => ({ ing: r.ing, qtyMilli: toMilli(r.qty) }));
      if (recipe.some((r) => r.qtyMilli < 1)) throw new AppError(400, "invalid_input", "Enter how much of each ingredient one portion uses.");
    }
    const fields = { ...data };
    delete fields.recipe;
    if (!settings.hasCategory(fields.cat)) throw new AppError(400, "invalid_input", "Choose a category from the list. An Admin adds categories under Settings.");
    // Each option group, and each choice inside one, needs its own name
    for (const g of fields.options || []) {
      if (new Set(g.choices.map((c) => c.name.toLowerCase())).size !== g.choices.length) throw new AppError(400, "invalid_input", `Each choice under ${g.name} needs its own name.`);
    }
    if (fields.options && new Set(fields.options.map((g) => g.name.toLowerCase())).size !== fields.options.length) throw new AppError(400, "invalid_input", "Each option group needs its own name.");

    // A case-insensitive comparison that treats the name purely as text
    const duplicate = await menu.findOne(
      { name: fields.name, ...(id ? { _id: { $ne: id } } : {}) },
      { session, collation: { locale: "en", strength: 2 } }
    );
    if (duplicate) throw new AppError(409, "name_taken", "An item with this name already exists.");

    if (!id) {
      const newId = await nextSequence(db, "menu", 0, session);
      await menu.insertOne({ _id: newId, ...fields, recipe: recipe || [] }, { session });
      await event("Menu item added", `${data.name} · ${data.cat} · Rs ${data.price}`, "warning");
      return newId;
    }

    const current = await menu.findOne({ _id: id }, { session });
    if (!current) throw new AppError(404, "not_found", "Item not found.");
    if (current.price !== data.price) await event("Price changed", `${current.name}: Rs ${current.price} to Rs ${data.price}`, "warning");
    if (current.available !== data.available) await event(data.available ? "Item switched on" : "Item switched off", data.name, "info");
    if (current.name !== data.name || current.cat !== data.cat || current.desc !== data.desc) await event("Menu item edited", data.name, "info");
    if (recipe) await event("Recipe changed", data.name, "info");
    if (fields.options && JSON.stringify(fields.options) !== JSON.stringify(current.options || [])) await event("Item options changed", data.name, "info");
    await menu.updateOne({ _id: id }, { $set: { ...fields, ...(recipe ? { recipe } : {}) } }, { session });
    return id;
  }

  async function deleteItem(req, id, session) {
    let deletedPhoto = null;
    const item = await menu.findOne({ _id: id }, { session });
    if (!item) throw new AppError(404, "not_found", "Item not found.");
    const inUse = await db.collection("orders").findOne({ billed: false, status: { $ne: "Cancelled" }, "items.id": id }, { session });
    if (inUse) throw new AppError(409, "item_in_use", "This item is on an open order. Remove it after the table has paid.");
    await menu.deleteOne({ _id: id }, { session });
    deletedPhoto = item.photo ? item.photo.file : null;
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Menu item deleted", details: `${item.name} · Rs ${item.price}`, severity: "high" }, { session });
    return deletedPhoto;
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
    if (deltaMilli < 0) await notifyIfCrossedReorder(updated, -deltaMilli, session);
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
