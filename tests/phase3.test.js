// Phase 3 (Pay): service charge, tips, paying a bill in parts (split and mixed methods), and shifts
// with the cash drawer and Z-report.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, freshCode } = require("./helpers");
const { calculateTotals } = require("../server/lib/domain");

const API = "/api/v1";
let ctx, db, app, config, admin, waiter, kitchen, cashier, cashier2, manager;
const charged = [];
// A gateway that approves at once and remembers what it was asked to charge
const gateway = {
  charge: async ({ reference, amount }) => { charged.push({ reference, amount }); return { status: "approved", reference, amount, gatewayRef: `G-${crypto.randomBytes(4).toString("hex")}` }; },
  refund: async ({ reference, amount }) => ({ status: "refunded", reference, amount, gatewayRef: "GR-1" })
};
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const stepUp = async (client) => assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
async function setSettings(change) {
  await stepUp(admin);
  const s = (await admin.get(`${API}/settings`)).body;
  const body = { version: s.version, taxRatePct: s.taxRatePct, tables: s.tables, discountLimits: s.discountLimits, receipt: s.receipt, categories: s.categories, orderTypes: s.orderTypes, serviceChargePct: s.serviceChargePct, requireShift: s.requireShift, ...change };
  const res = await admin.put(`${API}/settings`, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
// A served dine-in order on a table, ready to bill
async function servedTable(table, lines = [{ id: 10, qty: 2 }]) {
  const order = (await waiter.post(`${API}/orders`, { table, lines }, key())).body;
  assert.ok(order.id, JSON.stringify(order));
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
  await waiter.post(`${API}/orders/${order.id}/serve`, {});
  return order;
}
const pay = (client, table, body) => client.post(`${API}/billing/tables/${table}/pay`, body, key());
const tab = async (client, table) => (await client.get(`${API}/billing/open-tables`)).body.tables.find((t) => t.no === table);

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db, undefined, gateway));
  [admin, waiter, kitchen, cashier, cashier2, manager] = await Promise.all(["Admin", "Waiter", "Kitchen", "Cashier", "Cashier", "Manager"].map(as));
});
after(() => ctx.stop());

describe("service charge", () => {
  test("is added to dine-in bills only, worked out on the discounted amount", async () => {
    await setSettings({ serviceChargePct: 10 });
    await servedTable(1);
    const res = await pay(cashier, 1, { method: "Card", discountPct: 10 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const expected = calculateTotals([{ price: 890, qty: 2 }], 10, 0.16, 0.1);
    assert.equal(res.body.service, expected.service);
    assert.equal(res.body.total, expected.total);
    assert.equal(expected.total, 1780 - 178 + 160 + 256);

    const takeaway = (await cashier.post(`${API}/orders`, { type: "takeaway", customer: { name: "Sana" }, lines: [{ id: 10, qty: 1 }] }, key())).body;
    await kitchen.post(`${API}/kitchen/tickets/${takeaway.id}/status`, { status: "Preparing" });
    await kitchen.post(`${API}/kitchen/tickets/${takeaway.id}/status`, { status: "Ready" });
    await cashier.post(`${API}/orders/${takeaway.id}/serve`, {});
    const bill = await cashier.post(`${API}/billing/orders/${takeaway.id}/pay`, { method: "Card" }, key());
    assert.equal(bill.body.service, 0);
    await setSettings({ serviceChargePct: 0 });
  });
});

describe("paying in parts", () => {
  test("a bill split in two: the table stays open until the parts add up, then frees", async () => {
    const order = await servedTable(2);
    const total = calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).total;
    const half = Math.ceil(total / 2);

    const first = await pay(cashier, 2, { method: "Card", amount: half });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.total, half);
    assert.equal(first.body.check.remaining, total - half);
    const open = await tab(cashier, 2);
    assert.equal(open.check.paid, half);
    assert.equal((await waiter.get(`${API}/orders`)).body.orders.find((o) => o.id === order.id).billed, false);
    assert.equal((await waiter.post(`${API}/orders`, { table: 2, lines: [{ id: 1, qty: 1 }] }, key())).body.error.code, "table_paying", "no new orders mid-payment");

    const second = await pay(cashier, 2, { method: "Cash", tendered: 5000 });
    assert.equal(second.status, 201);
    assert.equal(second.body.total, total - half);
    assert.equal(second.body.check.remaining, 0);
    assert.equal(second.body.check.status, "Closed");
    assert.equal(first.body.tax + second.body.tax, calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).tax, "the parts' tax adds up exactly");
    assert.equal(await tab(cashier, 2), undefined, "the table is free");
    assert.equal((await waiter.get(`${API}/orders`)).body.orders.find((o) => o.id === order.id).billed, true);
  });

  test("a part cannot be more than what is left, and the discount is fixed by the first part", async () => {
    await servedTable(3);
    assert.equal((await pay(cashier, 3, { method: "Card", amount: 999999 })).body.error.code, "bad_amount");
    assert.equal((await pay(cashier, 3, { method: "Card", amount: 500, discountPct: 5 })).status, 201);
    assert.equal((await pay(cashier, 3, { method: "Card", amount: 100, discountPct: 10 })).body.error.code, "discount_locked");
    const rest = await pay(cashier, 3, { method: "Card" });
    assert.equal(rest.status, 201);
    assert.equal(rest.body.discountPct, 5);
  });

  test("two cashiers paying the last part at once: only one is recorded", async () => {
    await servedTable(4);
    const results = await Promise.all([pay(cashier, 4, { method: "Card" }), pay(cashier2, 4, { method: "Card" })]);
    assert.deepEqual(results.map((r) => r.status === 201).filter(Boolean).length, 1, JSON.stringify(results.map((r) => r.body)));
    assert.equal(await db.collection("bills").countDocuments({ table: 4 }), 1);
  });

  test("a manager cannot void an order part-way through being paid", async () => {
    const order = await servedTable(5);
    await pay(cashier, 5, { method: "Card", amount: 300 });
    await stepUp(manager);
    assert.equal((await manager.post(`${API}/orders/${order.id}/void`, { reason: "Guest left" })).body.error.code, "order_paying");
    await pay(cashier, 5, { method: "Card" });
  });
});

describe("tips", () => {
  test("a tip is charged on top, kept apart from sales, and the gateway is asked for the full amount", async () => {
    await servedTable(6);
    const due = calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).total;
    assert.equal((await pay(cashier, 6, { method: "Cash", tip: 200, tendered: due })).body.error.code, "cash_too_low", "cash must cover the tip too");
    const card = await pay(cashier, 6, { method: "Card", tip: 200 });
    assert.equal(card.status, 201, JSON.stringify(card.body));
    assert.equal(card.body.total, due);
    assert.equal(card.body.tip, 200);
    assert.equal(card.body.charge, due + 200);
    assert.deepEqual(charged.find((c) => c.reference === card.body.no), { reference: card.body.no, amount: due + 200 });
    const report = (await manager.get(`${API}/reports/sales`)).body;
    assert.ok(report.tips >= 200);
    const bills = (await manager.get(`${API}/bills`)).body.bills.filter((b) => b.status === "Paid");
    assert.equal(report.revenue, bills.reduce((s, b) => s + b.total, 0), "revenue does not include tips");
  });
});

describe("shifts and the Z-report", () => {
  test("open, take cash, move cash, close: the drawer is worked out and the difference recorded", async () => {
    const opened = await cashier.post(`${API}/shifts`, { float: 5000 });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal((await cashier.post(`${API}/shifts`, { float: 1 })).body.error.code, "shift_open");

    await servedTable(7);
    const due = calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).total;
    const bill = await pay(cashier, 7, { method: "Cash", tip: 100, tendered: due + 100 });
    assert.equal(bill.status, 201);
    assert.equal((await db.collection("bills").findOne({ _id: bill.body.no })).shiftId, opened.body.id);

    assert.equal((await cashier.post(`${API}/shifts/current/cash`, { type: "in", amount: 1000, reason: "Change from bank" })).status, 200);
    assert.equal((await cashier.post(`${API}/shifts/current/cash`, { type: "out", amount: 999999, reason: "Too much" })).body.error.code, "drawer_short");
    const now = (await cashier.post(`${API}/shifts/current/cash`, { type: "out", amount: 400, reason: "Milk supplier" })).body;
    const expected = 5000 + due + 100 + 1000 - 400;
    assert.equal(now.expected, expected);

    const z = await cashier.post(`${API}/shifts/current/close`, { counted: expected - 50, note: "One note missing" });
    assert.equal(z.status, 200, JSON.stringify(z.body));
    assert.equal(z.body.overShort, -50);
    assert.equal(z.body.tips, 100);
    assert.equal(z.body.byMethod.Cash, due + 100);
    assert.equal(z.body.status, "Closed");
    assert.equal((await cashier.get(`${API}/shifts/current`)).body.shift, null);
    assert.ok(await db.collection("audit_events").findOne({ action: "Shift closed", details: { $regex: "short Rs 50" } }));

    const list = (await manager.get(`${API}/shifts`)).body.shifts;
    assert.ok(list.some((s) => s.id === opened.body.id && s.overShort === -50));
  });

  test("when Settings require it, a cashier cannot take money without an open shift", async () => {
    await setSettings({ requireShift: true });
    await servedTable(8);
    assert.equal((await pay(cashier2, 8, { method: "Card" })).body.error.code, "no_shift");
    await cashier2.post(`${API}/shifts`, { float: 0 });
    assert.equal((await pay(cashier2, 8, { method: "Card" })).status, 201);
    await setSettings({ requireShift: false });
  });

  test("only cashiers and managers run shifts; only managers and admins see all of them", async () => {
    assert.equal((await waiter.post(`${API}/shifts`, { float: 0 })).status, 403);
    assert.equal((await cashier.get(`${API}/shifts`)).status, 403);
    assert.equal((await admin.get(`${API}/shifts`)).status, 200);
    assert.equal((await cashier.post(`${API}/shifts`, { float: -5 })).status, 400);
  });
});
