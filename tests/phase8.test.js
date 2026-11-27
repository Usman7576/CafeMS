// Phase 8 (Insight): sales over a range, busiest hours, product mix with cost and margin, profit after
// ingredients, waste and staff pay, sales by staff, the daily close, pay rates and CSV exports.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn } = require("./helpers");
const { localDate, dayRange } = require("../server/lib/domain");

const API = "/api/v1";
let ctx, db, app, config, admin, manager, waiter, cashier;
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const today = localDate();
const HOUR = 60 * 60 * 1000;

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  [admin, manager, waiter, cashier] = await Promise.all(["Admin", "Manager", "Waiter", "Cashier"].map(as));
  const now = new Date(dayRange(today).start.getTime() + 12 * HOUR);
  // Two espressos (Rs 350, 18 g coffee at Rs 6,500/kg) on a dine-in bill, and a split check for a club
  // sandwich: half by card with a tip, half in cash. One refunded bill does not count.
  await db.collection("orders").insertMany([
    { _id: "ORD-90001", waiter: waiter.user.username, table: 1, items: [], status: "Served", billed: true },
    { _id: "ORD-90002", waiter: waiter.user.username, table: 2, items: [], status: "Served", billed: true }
  ]);
  await db.collection("bills").insertMany([
    { _id: "B-90001", type: "dine-in", orderIds: ["ORD-90001"], lines: [{ id: 1, name: "Espresso", cat: "Coffee", price: 350, qty: 2 }], subtotal: 700, discount: 0, service: 0, tax: 112, total: 812, tip: 0, method: "Cash", cashier: cashier.user.username, status: "Paid", createdAt: now },
    { _id: "B-90002", type: "dine-in", checkId: "C-1", share: 0.5, orderIds: ["ORD-90002"], lines: [{ id: 10, name: "Chicken Club Sandwich", cat: "Food", price: 890, qty: 1 }], subtotal: 445, discount: 0, service: 0, tax: 71, total: 516, tip: 50, method: "Card", cashier: cashier.user.username, status: "Paid", createdAt: now },
    { _id: "B-90003", type: "dine-in", checkId: "C-1", share: 0.5, orderIds: ["ORD-90002"], lines: [{ id: 10, name: "Chicken Club Sandwich", cat: "Food", price: 890, qty: 1 }], subtotal: 445, discount: 0, service: 0, tax: 71, total: 516, tip: 0, method: "Cash", cashier: cashier.user.username, status: "Paid", createdAt: now },
    { _id: "B-90004", type: "takeaway", orderIds: [], lines: [{ id: 1, name: "Espresso", cat: "Coffee", price: 350, qty: 1 }], subtotal: 350, discount: 0, service: 0, tax: 56, total: 406, tip: 0, method: "Cash", cashier: cashier.user.username, status: "Refunded", createdAt: now }
  ]);
  await db.collection("timeclock").insertMany([
    { _id: "TC-90001", username: waiter.user.username, role: "Waiter", in: new Date(now - 4 * HOUR), out: new Date(now - 0.5 * HOUR), by: "self" },
    { _id: "TC-90002", username: cashier.user.username, role: "Cashier", in: new Date(now - 2 * HOUR), out: new Date(now), by: "self" }
  ]);
  await db.collection("waste_log").insertOne({ _id: "W-90001", ing: 2, name: "Milk", qtyMilli: 500, value: 110, at: now });
});
after(() => ctx.stop());

describe("sales summary", () => {
  test("counts paid bills, keeps tips and refunds apart, and counts a split check as one visit", async () => {
    const s = (await manager.get(`${API}/insights/summary?from=${today}&to=${today}`)).body;
    assert.equal(s.revenue, 812 + 516 + 516);
    assert.equal(s.net, 700 + 445 + 445);
    assert.equal(s.tips, 50);
    assert.equal(s.bills, 3);
    assert.equal(s.checks, 2);
    assert.equal(s.avgTicket, Math.round(1844 / 2));
    assert.equal(s.refunds, 1);
    assert.equal(s.refundAmount, 406);
    assert.equal(s.byMethod.Cash, 812 + 516);
    assert.equal(s.byDay.length, 1);
    assert.equal(s.heat.length, 7);
    assert.equal(s.heat.flat().reduce((a, b) => a + b, 0), 1844);
  });

  test("ranges are checked", async () => {
    assert.equal((await manager.get(`${API}/insights/summary?from=2026-02-01&to=2026-01-01`)).status, 400);
    assert.equal((await manager.get(`${API}/insights/summary?from=2025-01-01&to=2025-12-31`)).body.error.message, "Choose a range of up to 92 days.");
    assert.equal((await waiter.get(`${API}/insights/summary`)).status, 403);
    assert.equal((await cashier.get(`${API}/insights/profit`)).status, 403);
  });
});

describe("product mix and profit", () => {
  test("each item shows its cost and margin from today's ingredient costs", async () => {
    const mix = (await manager.get(`${API}/insights/mix`)).body;
    const espresso = mix.items.find((i) => i.name === "Espresso");
    assert.equal(espresso.qty, 2);
    assert.equal(espresso.sales, 700);
    assert.equal(espresso.cost, Math.round(2 * 0.018 * 6500));
    const club = mix.items.find((i) => i.name === "Chicken Club Sandwich");
    assert.equal(club.qty, 1, "two halves of a split make one sandwich");
    assert.equal(mix.total, 700 + 890);
  });

  test("profit takes off ingredients, waste and staff pay at each person's rate", async () => {
    assert.equal((await manager.put(`${API}/pay-rates/${waiter.user.username}`, { rate: 300 })).status, 200);
    assert.ok(await db.collection("audit_events").findOne({ action: "Pay rate changed" }));
    const p = (await manager.get(`${API}/insights/profit`)).body;
    const mix = (await manager.get(`${API}/insights/mix`)).body;
    const ingredients = mix.items.reduce((s, i) => s + i.cost, 0);
    assert.equal(p.net, 1590);
    assert.equal(p.ingredients, ingredients);
    assert.equal(p.waste, 110);
    assert.equal(p.labour, Math.round(3.5 * 300), "3.5 hours at Rs 300; the cashier has no rate yet");
    assert.equal(p.profit, 1590 - ingredients - 110 - 1050);
    assert.deepEqual(p.missingRates.length, 1);
    assert.equal((await waiter.get(`${API}/pay-rates`)).status, 403, "pay is private");
    assert.equal((await cashier.put(`${API}/pay-rates/${cashier.user.username}`, { rate: 9999 })).status, 403);
  });
});

describe("staff, daily close and exports", () => {
  test("sales by the waiter who took them and the cashier who collected them", async () => {
    const s = (await manager.get(`${API}/insights/staff`)).body;
    const w = s.people.find((p) => p.username === waiter.user.username);
    const c = s.people.find((p) => p.username === cashier.user.username);
    assert.equal(w.sold, 1590);
    assert.equal(w.minutes, 210);
    assert.equal(w.salesPerHour, Math.round(1590 / 3.5));
    assert.equal(c.collected, 1844);
    assert.equal(c.tips, 50);
  });

  test("the daily close brings the day together", async () => {
    const close = (await manager.get(`${API}/insights/close?date=${today}`)).body;
    assert.equal(close.revenue, 1844);
    assert.equal(close.refundAmount, 406);
    assert.equal(close.waste, 110);
    assert.equal(close.top[0].name, "Chicken Club Sandwich");
    assert.equal(typeof close.shifts.overShort, "number");
  });

  test("CSV exports download, and are recorded", async () => {
    for (const path of ["days.csv", "mix.csv", "staff.csv"]) {
      const res = await admin.get(`${API}/insights/${path}?from=${today}&to=${today}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers["content-type"], /text\/csv/);
      assert.match(res.headers["content-disposition"], new RegExp(today));
    }
    assert.match((await admin.get(`${API}/insights/mix.csv`)).text, /Espresso,Coffee,2,700/);
    assert.ok(await db.collection("audit_events").findOne({ action: "Report exported", details: { $regex: "Product mix CSV" } }));
  });

  test("today compares with the same day last week", async () => {
    const t = (await manager.get(`${API}/insights/today`)).body;
    assert.equal(t.revenue, 1844);
    assert.equal(t.lastWeek, 0);
    assert.equal(t.change, null, "no change is shown when last week had nothing");
    assert.equal(t.top.length, 2);
  });
});
