// Phase 6 (Online): guests order takeaway or delivery from the website, or dine-in from a QR code on
// their table. Each order waits until staff accept or decline it, and the guest follows it with a
// private tracking link.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, freshCode, ORIGIN } = require("./helpers");
const { calculateTotals } = require("../server/lib/domain");

const API = "/api/v1";
let ctx, db, app, config, admin, waiter, waiter2, kitchen, cashier;
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const stepUp = async (client) => assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
const guest = (body) => request(app).post(`${API}/public/orders`).set("Origin", ORIGIN).send(body);
const track = (link) => request(app).get(`${API}/public/orders/${link.split("t=")[1]}`);
const order = (extra = {}) => ({ type: "takeaway", customer: { name: "Sana Ali", phone: "03001234567" }, lines: [{ id: 10, qty: 2 }], ...extra });

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  // Many guest orders come from one test address, so the hourly limit is raised here and tested below
  ({ app, config } = buildApp(db, { publicBookingsPerHour: 100000 }));
  [admin, waiter, waiter2, kitchen, cashier] = await Promise.all(["Admin", "Waiter", "Waiter", "Kitchen", "Cashier"].map(as));
});
after(() => ctx.stop());

describe("ordering from the website", () => {
  test("a guest orders takeaway: it waits, stock is held, and it is not sent to the kitchen yet", async () => {
    const before = (await db.collection("inventory").findOne({ _id: 8 })).qtyMilli;
    const res = await guest(order());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.total, calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).total);
    assert.match(res.body.track, /^\/track\.html\?t=[A-Za-z0-9_-]{24,}$/);
    assert.ok((await db.collection("inventory").findOne({ _id: 8 })).qtyMilli < before, "stock is held");
    const stored = await db.collection("orders").findOne({ _id: res.body.id });
    assert.equal(stored.status, "Pending");
    assert.ok(!JSON.stringify(stored).includes(res.body.track.split("t=")[1]), "only a hash of the tracking token is stored");
    assert.ok(!(await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === res.body.id));
    const status = await track(res.body.track);
    assert.equal(status.body.status, "Pending");
    assert.match(status.body.message, /Waiting for the cafe/);
    assert.doesNotMatch(JSON.stringify(status.body), /03001234567|0300-|waiter/i, "the tracking page shows no contact details or staff");
  });

  test("staff accept an order: it goes to the kitchen and the guest sees it move on", async () => {
    const placed = (await guest(order())).body;
    const queue = (await cashier.get(`${API}/orders/incoming`)).body.orders;
    assert.ok(queue.some((o) => o.id === placed.id && o.customer.phone === "0300-•••••67"));
    const accepted = await cashier.post(`${API}/orders/${placed.id}/accept`, {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.status, "Placed");
    assert.equal((await cashier.post(`${API}/orders/${placed.id}/accept`, {})).status, 409, "accepted once");
    assert.ok((await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === placed.id));
    await kitchen.post(`${API}/kitchen/tickets/${placed.id}/status`, { status: "Preparing" });
    assert.equal((await track(placed.track)).body.message, "Being prepared");
    await kitchen.post(`${API}/kitchen/tickets/${placed.id}/status`, { status: "Ready" });
    assert.equal((await track(placed.track)).body.message, "Ready to collect");
    // The accepting cashier now owns it, hands it over and bills it
    assert.equal((await cashier.post(`${API}/orders/${placed.id}/serve`, {})).status, 200);
    assert.equal((await cashier.post(`${API}/billing/orders/${placed.id}/pay`, { method: "Cash", tendered: 5000 }, key())).status, 201);
    assert.equal((await track(placed.track)).body.paid, true);
  });

  test("a declined order returns its stock, and the guest sees why", async () => {
    const before = (await db.collection("inventory").findOne({ _id: 8 })).qtyMilli;
    const placed = (await guest(order())).body;
    const res = await cashier.post(`${API}/orders/${placed.id}/decline`, { reason: "Kitchen closing early" });
    assert.equal(res.status, 200);
    assert.equal((await db.collection("inventory").findOne({ _id: 8 })).qtyMilli, before);
    const status = (await track(placed.track)).body;
    assert.equal(status.status, "Cancelled");
    assert.equal(status.reason, "Kitchen closing early");
  });

  test("the guest must give a number; delivery needs an address; prices and bots are refused", async () => {
    assert.match((await guest(order({ customer: { name: "Sana" } }))).body.error.message, /mobile number/);
    assert.match((await guest(order({ type: "delivery" }))).body.error.message, /delivery address/);
    assert.equal((await guest(order({ lines: [{ id: 10, qty: 1, price: 1 }] }))).status, 400);
    const bot = await guest(order({ website: "http://spam" }));
    assert.equal(bot.status, 202);
    assert.equal(bot.body.track, undefined);
    assert.equal((await request(app).get(`${API}/public/orders/${"x".repeat(32)}`)).status, 404);
  });

  test("ordering can be switched off in Settings", async () => {
    await stepUp(admin);
    const s = (await admin.get(`${API}/settings`)).body;
    const body = { version: s.version, taxRatePct: s.taxRatePct, tables: s.tables, discountLimits: s.discountLimits, receipt: s.receipt, categories: s.categories, orderTypes: s.orderTypes, online: { ordering: false, qr: true } };
    assert.equal((await admin.put(`${API}/settings`, body)).status, 200);
    assert.equal((await request(app).get(`${API}/public/ordering`)).body.open, false);
    assert.equal((await guest(order())).status, 403);
    assert.equal((await admin.put(`${API}/settings`, { ...body, version: s.version + 1, online: { ordering: true, qr: true } })).status, 200);
  });
});

describe("ordering from a table's QR code", () => {
  let codes;
  test("an Admin gets a QR code per table; a new code replaces the old one", async () => {
    codes = (await admin.get(`${API}/tables/qr`)).body.tables;
    assert.equal(codes.length, 10);
    assert.match(codes[0].url, /\/order-online\.html\?table=[A-Za-z0-9_-]{16}$/);
    assert.match(codes[0].qr, /^data:image\/png;base64,/);
    assert.equal((await waiter.get(`${API}/tables/qr`)).status, 403);
    const old = codes[1].url.split("table=")[1];
    await stepUp(admin);
    assert.equal((await admin.post(`${API}/tables/2/qr`, {})).status, 204);
    assert.equal((await request(app).get(`${API}/public/table/${old}`)).status, 404, "the old code stops working");
    codes = (await admin.get(`${API}/tables/qr`)).body.tables;
  });

  test("a guest at table 4 orders; a waiter accepts it and the table becomes theirs", async () => {
    const code = codes.find((c) => c.no === 4).url.split("table=")[1];
    assert.deepEqual((await request(app).get(`${API}/public/table/${code}`)).body, { table: 4 });
    const placed = await guest({ tableCode: code, customer: {}, lines: [{ id: 1, qty: 2 }] });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.label, "Table 4");
    const tables = (await waiter.get(`${API}/tables`)).body.tables;
    assert.equal(tables.find((t) => t.no === 4).label, "Order waiting");
    assert.equal((await waiter.post(`${API}/orders/${placed.body.id}/accept`, {})).status, 200);
    assert.equal((await waiter.get(`${API}/tables`)).body.tables.find((t) => t.no === 4).state, "mine");
    // Another waiter cannot accept a table order where someone else is serving
    const again = await guest({ tableCode: code, customer: {}, lines: [{ id: 1, qty: 1 }] });
    assert.equal((await waiter2.post(`${API}/orders/${again.body.id}/accept`, {})).body.error.code, "table_taken");
    assert.equal((await waiter.post(`${API}/orders/${again.body.id}/accept`, {})).status, 200);
  });

  test("one connection can send only a few orders an hour", async () => {
    const limited = buildApp(db, { publicBookingsPerHour: 2 }).app;
    const send = () => request(limited).post(`${API}/public/orders`).set("Origin", ORIGIN).send(order({ lines: [{ id: 1, qty: 1 }] }));
    const results = [await send(), await send(), await send()];
    assert.deepEqual(results.map((r) => r.status), [201, 201, 429]);
    for (const r of results.slice(0, 2)) await cashier.post(`${API}/orders/${r.body.id}/decline`, { reason: "Test order" });
  });

  test("a made-up table code is refused, and the kitchen cannot accept orders", async () => {
    assert.equal((await guest({ tableCode: "A".repeat(16), customer: {}, lines: [{ id: 1, qty: 1 }] })).status, 404);
    const placed = (await guest(order())).body;
    assert.equal((await kitchen.post(`${API}/orders/${placed.id}/accept`, {})).status, 403);
    await cashier.post(`${API}/orders/${placed.id}/decline`, { reason: "Test order" });
  });
});
