// Starting menu and stock. Quantities are in thousandths of a unit (see lib/domain.js).
// cost is in rupees per unit
const ingredient = (id, name, unit, qty, reorder, supplier, cost) => ({ _id: id, name, unit, qtyMilli: Math.round(qty * 1000), reorderMilli: Math.round(reorder * 1000), supplier, costPaisa: Math.round(cost * 100) });
const r = (ing, qty) => ({ ing, qtyMilli: Math.round(qty * 1000) });
const item = (id, name, cat, price, desc, recipe) => ({ _id: id, name, cat, price, desc, available: true, recipe });

const INVENTORY = [
  ingredient(1, "Coffee beans", "kg", 4.2, 2, "Bean Roasters Co.", 6500),
  ingredient(2, "Milk", "L", 18, 8, "Premier Dairy", 220),
  ingredient(3, "Sugar", "kg", 6, 2, "Metro Wholesale", 160),
  ingredient(4, "Caramel syrup", "L", 0.4, 0.5, "Sweet Supplies", 2400),
  ingredient(5, "Mango pulp", "kg", 0, 2, "FreshFarm Produce", 450),
  ingredient(6, "Tea leaves", "kg", 1.5, 0.5, "Metro Wholesale", 1800),
  ingredient(7, "Limes", "pcs", 40, 20, "FreshFarm Produce", 15),
  ingredient(8, "Chicken breast", "kg", 3.5, 2, "Metro Wholesale", 1100),
  ingredient(9, "Bread slices", "pcs", 64, 30, "Metro Wholesale", 12),
  ingredient(10, "Potatoes", "kg", 9, 5, "FreshFarm Produce", 120),
  ingredient(11, "Cheese", "kg", 1.2, 1.5, "Premier Dairy", 2600),
  ingredient(12, "Chocolate", "kg", 2, 1, "Sweet Supplies", 3200),
  ingredient(13, "Cream cheese", "kg", 0, 1, "Premier Dairy", 2800),
  ingredient(14, "Croissant dough", "pcs", 18, 10, "Sweet Supplies", 70),
  ingredient(15, "Green tea", "kg", 0.6, 0.3, "Metro Wholesale", 4000),
  ingredient(16, "Vanilla syrup", "L", 1.1, 0.5, "Sweet Supplies", 2200)
];

const MENU = [
  item(1, "Espresso", "Coffee", 350, "Double shot, rich crema.", [r(1, 0.018)]),
  item(2, "Cappuccino", "Coffee", 520, "Espresso, steamed milk, thick foam.", [r(1, 0.018), r(2, 0.15)]),
  item(3, "Caffè Latte", "Coffee", 550, "Smooth espresso with silky milk.", [r(1, 0.018), r(2, 0.25)]),
  item(4, "Caramel Macchiato", "Coffee", 650, "Vanilla, milk, espresso, caramel drizzle.", [r(1, 0.018), r(2, 0.2), r(4, 0.03), r(16, 0.02)]),
  item(5, "Iced Americano", "Cold Drinks", 480, "Espresso over ice and cold water.", [r(1, 0.018)]),
  item(6, "Mango Smoothie", "Cold Drinks", 590, "Fresh mango, yoghurt, honey.", [r(5, 0.25), r(2, 0.15)]),
  item(7, "Fresh Lime Soda", "Cold Drinks", 300, "Sweet or salted.", [r(7, 2), r(3, 0.02)]),
  item(8, "Green Tea", "Tea", 250, "Jasmine green tea, pot for one.", [r(15, 0.005)]),
  item(9, "Karak Chai", "Tea", 220, "Strong spiced milk tea.", [r(6, 0.01), r(2, 0.15), r(3, 0.02)]),
  item(10, "Chicken Club Sandwich", "Food", 890, "Grilled chicken, egg, served with fries.", [r(8, 0.15), r(9, 3), r(10, 0.15)]),
  item(11, "Grilled Panini", "Food", 820, "Mozzarella, pesto, sun-dried tomato.", [r(9, 2), r(11, 0.08)]),
  item(12, "Loaded Fries", "Food", 560, "Cheese sauce, jalapeños, spring onion.", [r(10, 0.3), r(11, 0.06)]),
  item(13, "Chocolate Brownie", "Desserts", 420, "Warm, with chocolate sauce.", [r(12, 0.06)]),
  item(14, "Blueberry Cheesecake", "Desserts", 690, "Baked New York style.", [r(13, 0.12)]),
  item(15, "Butter Croissant", "Desserts", 380, "Freshly baked every morning.", [r(14, 1)])
];

async function seedCatalog(db) {
  if (!(await db.collection("menu").countDocuments())) await db.collection("menu").insertMany(MENU);
  if (!(await db.collection("inventory").countDocuments())) await db.collection("inventory").insertMany(INVENTORY);
  await db.collection("counters").updateOne({ _id: "menu" }, { $max: { value: MENU.length } }, { upsert: true });
  // Suppliers named on the stock list become supplier records, once
  if (!(await db.collection("suppliers").countDocuments())) {
    const names = [...new Set((await db.collection("inventory").find({}, { projection: { supplier: 1 } }).toArray()).map((i) => i.supplier).filter(Boolean))].sort();
    for (const [i, name] of names.entries()) {
      const id = `SUP-${i + 1}`;
      await db.collection("suppliers").insertOne({ _id: id, name, phone: "", email: "", notes: "", active: true, createdAt: new Date() });
      await db.collection("inventory").updateMany({ supplier: name }, { $set: { supplierId: id } });
    }
    await db.collection("counters").updateOne({ _id: "supplier" }, { $max: { value: names.length } }, { upsert: true });
  }
  // Starting costs for ingredients that have none yet; costs an Admin or Manager has set are kept
  for (const ing of INVENTORY) await db.collection("inventory").updateOne({ _id: ing._id, costPaisa: { $exists: false } }, { $set: { costPaisa: ing.costPaisa } });
}

// Starting photos (free-licence, credited in seed-photos/CREDITS.md). Each is copied into the upload folder
// under a random name, the same way an Admin's upload is stored. Items that already have a photo keep it,
// so this never replaces a photo an Admin has chosen.
async function seedPhotos(db, uploadDir) {
  const fs = require("fs/promises");
  const path = require("path");
  const { randomToken } = require("../server/lib/crypto");
  const folder = path.join(__dirname, "seed-photos");
  let added = 0;
  for (const m of MENU) {
    const source = path.join(folder, `${String(m._id).padStart(2, "0")}.jpg`);
    const current = await db.collection("menu").findOne({ _id: m._id });
    if (!current || current.photo) continue;
    const bytes = await fs.readFile(source).catch(() => null);
    if (!bytes) continue;
    await fs.mkdir(uploadDir, { recursive: true });
    const file = `${randomToken(24)}.jpg`;
    await fs.writeFile(path.join(uploadDir, file), bytes, { flag: "wx", mode: 0o640 });
    const result = await db.collection("menu").updateOne({ _id: m._id, photo: { $exists: false } }, { $set: { photo: { file, type: "image/jpeg" } } });
    if (result.modifiedCount) added += 1; else await fs.rm(path.join(uploadDir, file), { force: true });
  }
  return added;
}

module.exports = { MENU, INVENTORY, seedCatalog, seedPhotos };
