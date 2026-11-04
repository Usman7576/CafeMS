const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startDb, buildApp, createUser, signIn, freshCode } = require("./helpers");
const { seedCatalog } = require("../scripts/seed-data");
const { calculateTotals } = require("../server/lib/domain");

let ctx, db, app, config, waiter, kitchen;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  waiter = await as("Waiter");
  kitchen = await as("Kitchen");
});
after(() => ctx.stop());

const API = "/api/v1";
const PHONE = "03001234567";
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  const client = await signIn(app, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}

// Creates a served order on a free table, which is what a cashier bills
async function servedTable(lines = [{ id: 1, qty: 2 }]) {
  await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
  const table = 1;
  const order = (await waiter.post(`${API}/orders`, { table, lines }, key())).body;
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
  await waiter.post(`${API}/orders/${order.id}/serve`, {});
  return { table, order };
}
const pay = (client, table, body = { method: "Card" }, opts = key()) => client.post(`${API}/billing/tables/${table}/pay`, body, opts);

describe("payment", () => {
  test("the total is calculated on the server; the browser cannot set it (Rs 2,500 to 250)", async () => {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    assert.equal((await pay(cashier, table, { method: "Card", total: 1 })).status, 400);
    const res = await pay(cashier, table);
    assert.equal(res.status, 201);
    assert.equal(res.body.total, calculateTotals([{ price: 350, qty: 2 }]).total);
  });

  test("the cashier recorded is the signed-in person", async () => {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    assert.equal((await pay(cashier, table)).body.cashier, cashier.user.username);
  });

  test("a waiter and the kitchen cannot take payment (finding 7)", async () => {
    const { table } = await servedTable();
    assert.equal((await pay(waiter, table)).status, 403);
    assert.equal((await pay(kitchen, table)).status, 403);
  });

  test("an unserved table cannot be billed", async () => {
    const cashier = await as("Cashier");
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    await waiter.post(`${API}/orders`, { table: 1, lines: [{ id: 1, qty: 1 }] }, key());
    assert.equal((await pay(cashier, 1)).body.error.code, "not_served");
  });

  test("discount limits depend on the role", async () => {
    const [cashier, manager] = [await as("Cashier"), await as("Manager")];
    let { table } = await servedTable();
    assert.equal((await pay(cashier, table, { method: "Card", discountPct: 11 })).body.error.code, "discount_limit");
    assert.ok(await db.collection("audit_events").findOne({ actor: cashier.user.username, action: "Access denied" }));
    assert.equal((await pay(cashier, table, { method: "Card", discountPct: 10 })).status, 201);
    ({ table } = await servedTable());
    assert.equal((await pay(manager, table, { method: "Card", discountPct: 26 })).body.error.code, "discount_limit");
    assert.equal((await pay(manager, table, { method: "Card", discountPct: 25 })).status, 201);
  });

  test("cash must cover the total, and bad amounts are refused", async () => {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    assert.equal((await pay(cashier, table, { method: "Cash", tendered: 10 })).body.error.code, "cash_too_low");
    assert.equal((await pay(cashier, table, { method: "Cash" })).body.error.code, "cash_too_low");
    for (const tendered of [-1, 1.5, "9999", 1e12]) assert.equal((await pay(cashier, table, { method: "Cash", tendered })).status, 400);
    const res = await pay(cashier, table, { method: "Cash", tendered: 1000 });
    assert.equal(res.body.change, 1000 - res.body.total);
  });

  test("a double click produces one bill", async () => {
    const cashier = await as("Cashier");
    const { table, order } = await servedTable();
    const same = key();
    const [a, b] = await Promise.all([pay(cashier, table, { method: "Card" }, same), pay(cashier, table, { method: "Card" }, same)]);
    assert.equal(a.body.no, b.body.no);
    assert.equal(await db.collection("bills").countDocuments({ orderIds: order.id }), 1);
  });

  test("a paid table cannot be billed again", async () => {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    await pay(cashier, table);
    assert.equal((await pay(cashier, table)).status, 404);
  });

  test("if any step fails, nothing is saved", async () => {
    const cashier = await as("Cashier");
    const { table, order } = await servedTable();
    const billCount = await db.collection("bills").countDocuments();
    await pay(cashier, table, { method: "Cash", tendered: 1 });
    assert.equal(await db.collection("bills").countDocuments(), billCount);
    assert.equal((await db.collection("orders").findOne({ _id: order.id })).billed, false);
  });
});

describe("customer phone numbers (finding 9)", () => {
  async function billWithPhone() {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    const bill = (await pay(cashier, table, { method: "Card", phone: "0300-1234567" })).body;
    return { cashier, bill };
  }

  test("stored encrypted, and masked in every response", async () => {
    const { cashier, bill } = await billWithPhone();
    assert.equal(bill.phone, "0300-•••••67");
    const stored = await db.collection("bills").findOne({ _id: bill.no });
    assert.ok(!JSON.stringify(stored).includes(PHONE));
    assert.ok(!JSON.stringify((await cashier.get(`${API}/bills`)).body).includes(PHONE));
    assert.ok(!JSON.stringify((await cashier.get(`${API}/bills/${bill.no}`)).body).includes(PHONE));
    const manager = await as("Manager");
    assert.ok(!JSON.stringify((await manager.get(`${API}/snapshot`)).body).includes(PHONE));
    const idempotency = await db.collection("idempotency").find().toArray();
    assert.ok(!JSON.stringify(idempotency).includes(PHONE));
  });

  test("only a Manager or Admin can see the full number, and it is logged", async () => {
    const { cashier, bill } = await billWithPhone();
    assert.equal((await cashier.get(`${API}/bills/${bill.no}/phone`)).status, 403);
    const manager = await as("Manager");
    assert.equal((await manager.get(`${API}/bills/${bill.no}/phone`)).body.phone, PHONE);
    const event = await db.collection("audit_events").findOne({ actor: manager.user.username, action: "Customer phone viewed" });
    assert.equal(event.details, bill.no);
  });

  test("the data cannot be read after being moved to another record", async () => {
    const { bill } = await billWithPhone();
    const manager = await as("Manager");
    const stored = await db.collection("bills").findOne({ _id: bill.no });
    const other = await db.collection("bills").findOne({ _id: { $ne: bill.no }, status: "Paid" });
    await db.collection("bills").updateOne({ _id: other._id }, { $set: { phoneEnc: stored.phoneEnc } });
    assert.equal((await manager.get(`${API}/bills/${other._id}/phone`)).status, 500);
  });

  test("bad phone numbers are refused", async () => {
    const cashier = await as("Cashier");
    const { table } = await servedTable();
    const res = await pay(cashier, table, { method: "Card", phone: "12345" });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /03XXXXXXXXX/);
  });
});

describe("refunds and separation of privilege", () => {
  async function paidBill(lines) {
    const cashier = await as("Cashier");
    const { table } = await servedTable(lines);
    return { cashier, bill: (await pay(cashier, table)).body };
  }
  const REFUND = (no) => `${API}/bills/${no}/refund`;
  const LARGE = [{ id: 10, qty: 6 }]; // 6 x Rs 890, over the Rs 5,000 limit

  test("a cashier cannot refund, and the attempt is recorded", async () => {
    const { cashier, bill } = await paidBill();
    assert.equal((await cashier.post(REFUND(bill.no), { reason: "Wrong item" }, key())).status, 403);
    assert.ok(await db.collection("audit_events").findOne({ actor: cashier.user.username, action: "Access denied" }));
    assert.equal((await db.collection("bills").findOne({ _id: bill.no })).status, "Paid");
  });

  test("a small refund works once, and needs a real reason", async () => {
    const { bill } = await paidBill();
    const manager = await as("Manager");
    assert.equal((await manager.post(REFUND(bill.no), { reason: "x" }, key())).status, 400);
    const res = await manager.post(REFUND(bill.no), { reason: "Wrong item" }, key());
    assert.equal(res.body.status, "Refunded");
    assert.equal(res.body.refund.by, manager.user.username);
    assert.equal((await manager.post(REFUND(bill.no), { reason: "Wrong item" }, key())).body.error.code, "already_refunded");
  });

  test("a large refund waits for a different person with a fresh code", async () => {
    const { bill } = await paidBill(LARGE);
    assert.ok(bill.total > 5000);
    const manager = await as("Manager");
    const requested = await manager.post(REFUND(bill.no), { reason: "Party cancelled" }, key());
    assert.equal(requested.status, 202);
    assert.equal((await db.collection("bills").findOne({ _id: bill.no })).status, "Paid");
    assert.equal((await manager.post(REFUND(bill.no), { reason: "Party cancelled" }, key())).body.error.code, "refund_pending");

    const APPROVE = `${API}/approvals/${requested.body.approvalId}/approve`;
    await stepUp(manager);
    assert.equal((await manager.post(APPROVE, {})).body.error.code, "same_person");

    const second = await as("Admin");
    assert.equal((await second.post(APPROVE, {})).body.error.code, "step_up_required");
    await stepUp(second);
    const done = await second.post(APPROVE, {});
    assert.equal(done.body.status, "Refunded");
    assert.equal(done.body.refund.by, manager.user.username);
    assert.equal(done.body.refund.approvedBy, second.user.username);
    assert.equal((await second.post(APPROVE, {})).body.error.code, "already_decided");
  });

  test("a rejected refund leaves the bill paid and open to a new request", async () => {
    const { bill } = await paidBill(LARGE);
    const manager = await as("Manager");
    const { approvalId } = (await manager.post(REFUND(bill.no), { reason: "Party cancelled" }, key())).body;
    const second = await as("Manager");
    await stepUp(second);
    assert.equal((await second.post(`${API}/approvals/${approvalId}/reject`, {})).status, 204);
    const stored = await db.collection("bills").findOne({ _id: bill.no });
    assert.equal(stored.status, "Paid");
    assert.equal(stored.refundPending, undefined);
  });

  test("an expired approval cannot be used, and other roles cannot decide", async () => {
    const { bill } = await paidBill(LARGE);
    const manager = await as("Manager");
    const { approvalId } = (await manager.post(REFUND(bill.no), { reason: "Party cancelled" }, key())).body;
    const cashier = await as("Cashier");
    assert.equal((await cashier.post(`${API}/approvals/${approvalId}/approve`, {})).status, 403);
    await db.collection("approvals").updateOne({ _id: approvalId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const second = await as("Admin");
    await stepUp(second);
    assert.equal((await second.post(`${API}/approvals/${approvalId}/approve`, {})).body.error.code, "already_decided");
    // The expired request must not leave the bill stuck
    assert.equal((await manager.post(REFUND(bill.no), { reason: "Party cancelled" }, key())).status, 202);
  });
});

test("a cashier sees today's bills only, whatever date is requested", async () => {
  const cashier = await as("Cashier");
  const { table } = await servedTable();
  const today = (await pay(cashier, table)).body;
  await db.collection("bills").updateOne({ _id: today.no }, { $set: { createdAt: new Date("2020-01-01T12:00:00Z") } });
  assert.deepEqual((await cashier.get(`${API}/bills?date=2020-01-01`)).body.bills.filter((b) => b.no === today.no), []);
  const manager = await as("Manager");
  assert.equal((await manager.get(`${API}/bills?date=2020-01-01`)).body.bills.filter((b) => b.no === today.no).length, 1);
});

describe("reports", () => {
  test("add up from stored bills and exclude refunded ones", async () => {
    await db.collection("bills").deleteMany({});
    const cashier = await as("Cashier");
    const manager = await as("Manager");
    let { table } = await servedTable([{ id: 1, qty: 1 }]);
    const a = (await pay(cashier, table)).body;
    ({ table } = await servedTable([{ id: 2, qty: 1 }]));
    const b = (await pay(cashier, table, { method: "Cash", tendered: 5000 })).body;
    await manager.post(`${API}/bills/${b.no}/refund`, { reason: "Wrong item" }, key());
    const report = (await manager.get(`${API}/reports/sales`)).body;
    assert.equal(report.revenue, a.total);
    assert.equal(report.bills, 1);
    assert.equal(report.refunds, 1);
    assert.equal(report.refundAmount, b.total);
    assert.equal(report.byMethod.Card, a.total);
  });

  test("exports are logged, limited per person, and safe to open in a spreadsheet", async () => {
    const user = await createUser(db, config, { role: "Manager" });
    const client = await signIn(app, db, user);
    const first = await client.get(`${API}/reports/sales.csv`);
    assert.equal(first.status, 200);
    assert.match(first.headers["content-type"], /text\/csv/);
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Report exported" }));
    for (let i = 0; i < 9; i++) await client.get(`${API}/reports/sales.csv`);
    assert.equal((await client.get(`${API}/reports/sales.csv`)).status, 429);
  });

  test("CSV cells that a spreadsheet would run as formulas are neutralised", () => {
    const { toCsv } = require("../server/lib/csv");
    const csv = toCsv([["=1+1", "+cmd", "-2", "@x", 5, -3, 'a"b,c']]);
    assert.ok(csv.includes("'=1+1"));
    assert.ok(csv.includes("'+cmd"));
    assert.ok(csv.includes("'-2"));
    assert.ok(csv.includes("'@x"));
    assert.ok(csv.includes(",-3,"));
    assert.ok(csv.includes('"a""b,c"'));
  });
});
