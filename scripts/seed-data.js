// Starting menu and stock. Quantities are in thousandths of a unit (see lib/domain.js).
const ingredient = (id, name, unit, qty, reorder, supplier) => ({ _id: id, name, unit, qtyMilli: Math.round(qty * 1000), reorderMilli: Math.round(reorder * 1000), supplier });
const r = (ing, qty) => ({ ing, qtyMilli: Math.round(qty * 1000) });
const item = (id, name, cat, price, desc, recipe) => ({ _id: id, name, cat, price, desc, available: true, recipe });

const INVENTORY = [
  ingredient(1, "Coffee beans", "kg", 4.2, 2, "Bean Roasters Co."),
  ingredient(2, "Milk", "L", 18, 8, "Premier Dairy"),
  ingredient(3, "Sugar", "kg", 6, 2, "Metro Wholesale"),
  ingredient(4, "Caramel syrup", "L", 0.4, 0.5, "Sweet Supplies"),
  ingredient(5, "Mango pulp", "kg", 0, 2, "FreshFarm Produce"),
  ingredient(6, "Tea leaves", "kg", 1.5, 0.5, "Metro Wholesale"),
  ingredient(7, "Limes", "pcs", 40, 20, "FreshFarm Produce"),
  ingredient(8, "Chicken breast", "kg", 3.5, 2, "Metro Wholesale"),
  ingredient(9, "Bread slices", "pcs", 64, 30, "Metro Wholesale"),
  ingredient(10, "Potatoes", "kg", 9, 5, "FreshFarm Produce"),
  ingredient(11, "Cheese", "kg", 1.2, 1.5, "Premier Dairy"),
  ingredient(12, "Chocolate", "kg", 2, 1, "Sweet Supplies"),
  ingredient(13, "Cream cheese", "kg", 0, 1, "Premier Dairy"),
  ingredient(14, "Croissant dough", "pcs", 18, 10, "Sweet Supplies"),
  ingredient(15, "Green tea", "kg", 0.6, 0.3, "Metro Wholesale"),
  ingredient(16, "Vanilla syrup", "L", 1.1, 0.5, "Sweet Supplies")
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
}

module.exports = { MENU, INVENTORY, seedCatalog };
