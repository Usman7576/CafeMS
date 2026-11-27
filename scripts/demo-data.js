// Demo data for showing CafeMS: the past seven days of trade, so Insights, the Overview and the Team
// page have something to show. Run with `npm run demo`; remove it all again with `npm run demo -- --remove`.
//
// It adds, all tagged demo: true:
//   - paid bills (with their orders) from your own menu and staff, between opening and closing time;
//   - clock-ins for the people who worked, and this week's rota;
//   - a few guest ratings, one voucher (DEMO10) and starting pay rates for anyone without one.
// It does not take stock, write audit entries or change anything that already exists. It refuses to run
// in production, and refuses to add a second set.
require("dotenv").config({ quiet: true });

const { loadConfig } = require("../server/config");
const { createClient, ensureIndexes } = require("../server/db");
const { nextSequence } = require("../server/lib/tx");
const { calculateTotals, dayRange, localDate } = require("../server/lib/domain");

const DAY = 24 * 60 * 60 * 1000;
const COLLECTIONS = ["bills", "orders", "timeclock", "rota", "feedback", "vouchers", "pay_rates"];
const RATES = { Waiter: 250, Barista: 280, Kitchen: 300, Cashier: 270, Manager: 450 };
const COMMENTS = ["Lovely coffee and friendly staff.", "Food took a while but tasted great.", "Our favourite place for chai.", "Cappuccino was perfect.", "A bit noisy at lunch.", "Great brownies!", "Quick takeaway, thank you."];

// A repeatable random sequence, so the same demo week is made each time
let seed = 42;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(random() * list.length)];

async function remove(db) {
  for (const name of COLLECTIONS) {
    const r = await db.collection(name).deleteMany({ demo: true });
    if (r.deletedCount) console.log(`Removed ${r.deletedCount} demo ${name}`);
  }
  console.log("Demo data removed.");
}

async function add(db) {
  if (await db.collection("bills").findOne({ demo: true })) throw new Error("Demo data is already there. Remove it first with: npm run demo -- --remove");
  const settingsDoc = await db.collection("settings").findOne({ _id: "operations" });
  const taxRate = settingsDoc && settingsDoc.taxRatePct !== undefined ? settingsDoc.taxRatePct / 100 : 0.16;
  const menu = await db.collection("menu").find({ available: true }).toArray();
  const staff = await db.collection("users").find({ status: "Active" }).toArray();
  const waiters = staff.filter((u) => u.role === "Waiter");
  const cashiers = staff.filter((u) => u.role === "Cashier");
  const crew = staff.filter((u) => RATES[u.role] && u.role !== "Manager");
  if (!menu.length || !waiters.length || !cashiers.length) throw new Error("Run npm run setup first: the demo needs the menu, waiters and a cashier.");

  let bills = 0;
  for (let back = 7; back >= 1; back -= 1) {
    const date = localDate(Date.now() - back * DAY);
    const start = dayRange(date).start.getTime();
    // Busier at lunch and in the evening, and at the weekend
    const weekend = [0, 6].includes(new Date(start + 12 * 3600000).getUTCDay());
    const visits = Math.round((weekend ? 38 : 26) + random() * 10);
    for (let v = 0; v < visits; v += 1) {
      const hour = pick([10, 11, 12, 12, 13, 13, 14, 15, 16, 17, 18, 19, 19, 20, 20, 21, 22]);
      const at = new Date(start + hour * 3600000 + Math.floor(random() * 55) * 60000);
      const lines = [];
      for (let n = 0, items = 1 + Math.floor(random() * 3); n < items; n += 1) {
        const m = pick(menu);
        const same = lines.find((l) => l.id === m._id);
        if (same) same.qty += 1; else lines.push({ id: m._id, name: m.name, cat: m.cat, price: m.price, qty: 1, options: [] });
      }
      const discountPct = random() < 0.06 ? 10 : 0;
      const t = calculateTotals(lines, discountPct, taxRate);
      const type = random() < 0.2 ? "takeaway" : "dine-in";
      const table = type === "dine-in" ? 1 + Math.floor(random() * 10) : null;
      const waiter = pick(waiters);
      const orderId = `ORD-${await nextSequence(db, "order", 1000)}`;
      const billNo = `B-${await nextSequence(db, "bill", 5000)}`;
      const method = pick(["Cash", "Cash", "Card", "Card", "Wallet"]);
      const tip = method !== "Cash" && random() < 0.3 ? pick([50, 100, 150]) : 0;
      await db.collection("orders").insertOne({
        _id: orderId, type, table, items: lines.map((l) => ({ ...l, station: "Kitchen", chosen: [] })), stockUsed: [], notes: "", status: "Served", stations: { Kitchen: "Ready" },
        waiter: waiter.username, createdAt: new Date(at - 25 * 60000), updatedAt: at, billed: true, billNo, version: 3, ...(type === "takeaway" ? { customer: { name: "Walk-in" } } : {}), demo: true
      });
      await db.collection("bills").insertOne({
        _id: billNo, table, type, label: table ? `Table ${table}` : "Takeaway · Walk-in", orderIds: [orderId], lines, discountPct,
        subtotal: t.sub, discount: t.discount, service: 0, tax: t.tax, total: t.total, tip, method, tendered: method === "Cash" ? Math.ceil(t.total / 500) * 500 : t.total + tip,
        change: method === "Cash" ? Math.ceil(t.total / 500) * 500 - t.total : 0, cashier: pick(cashiers).username, createdAt: at, status: "Paid", demo: true
      });
      bills += 1;
    }
    // The crew worked the day: one shift each, morning or evening
    for (const person of crew) {
      if (random() < 0.15) continue;
      const early = random() < 0.5;
      const inAt = new Date(start + (early ? 9.5 : 15) * 3600000 + Math.floor(random() * 15) * 60000);
      const outAt = new Date(inAt.getTime() + (7.5 + random()) * 3600000);
      await db.collection("timeclock").insertOne({ _id: `TC-${await nextSequence(db, "timeclock", 1000)}`, username: person.username, role: person.role, in: inAt, out: outAt, by: "self", demo: true });
    }
  }

  // This week's rota
  let shifts = 0;
  for (let ahead = 0; ahead < 7; ahead += 1) {
    const date = localDate(Date.now() + ahead * DAY);
    for (const person of crew) {
      if (random() < 0.2) continue;
      const early = random() < 0.5;
      await db.collection("rota").insertOne({ _id: `RO-${await nextSequence(db, "rota", 1000)}`, username: person.username, date, start: early ? "09:30" : "15:00", end: early ? "17:30" : "23:00", role: person.role, note: early ? "Opening" : "Closing", by: "demo", at: new Date(), demo: true });
      shifts += 1;
    }
  }

  for (let i = 0; i < 12; i += 1) {
    await db.collection("feedback").insertOne({ rating: pick([5, 5, 5, 4, 4, 4, 3, 2]), comment: pick(COMMENTS), name: "", billNo: null, at: new Date(Date.now() - Math.floor(random() * 7) * DAY - 3600000), demo: true });
  }
  if (!(await db.collection("vouchers").findOne({ _id: "DEMO10" }))) {
    await db.collection("vouchers").insertOne({ _id: "DEMO10", kind: "percent", value: 10, minSpend: 1000, expiresOn: null, maxUses: 50, uses: 0, active: true, createdBy: "demo", createdAt: new Date(), demo: true });
  }
  for (const person of staff.filter((u) => RATES[u.role])) {
    await db.collection("pay_rates").updateOne({ _id: person.username }, { $setOnInsert: { rate: RATES[person.role], setBy: "demo", setAt: new Date(), demo: true } }, { upsert: true });
  }
  console.log(`Added ${bills} paid bills over the past 7 days, ${shifts} rota shifts, clock-ins, 12 ratings, voucher DEMO10 and starting pay rates.`);
  console.log("Remove it all with: npm run demo -- --remove");
}

async function main() {
  const config = loadConfig(process.env);
  if (config.isProduction) throw new Error("Demo data cannot be added in production.");
  const client = createClient(config);
  await client.connect();
  try {
    const db = client.db(config.mongoDb);
    await ensureIndexes(db);
    if (process.argv.includes("--remove")) await remove(db); else await add(db);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`Demo data: ${error.message}`);
  process.exitCode = 1;
});
