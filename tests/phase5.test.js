// Phase 5 (Guests): loyalty members and points (earned on paid bills, spent as a payment, taken back
// on refund), vouchers, booking times checked against free tables, the waitlist and guest feedback.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, freshCode, browser } = require("./helpers");
const { calculateTotals, localDate } = require("../server/lib/domain");

const API = "/api/v1";
let ctx, db, app, config, admin, waiter, kitchen, cashier, manager;
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const stepUp = async (client) => assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
let tableNo = 0;
async function servedTable(lines = [{ id: 10, qty: 2 }]) {
  tableNo += 1;
  const order = (await waiter.post(`${API}/orders`, { table: tableNo, lines }, key())).body;
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
  await waiter.post(`${API}/orders/${order.id}/serve`, {});
  return tableNo;
}
const pay = (table, body) => cashier.post(`${API}/billing/tables/${table}/pay`, body, key());
const tomorrow = () => localDate(Date.now() + 24 * 60 * 60 * 1000);

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  [admin, waiter, kitchen, cashier, manager] = await Promise.all(["Admin", "Waiter", "Kitchen", "Cashier", "Manager"].map(as));
});
after(() => ctx.stop());

describe("loyalty members and points", () => {
  let member;
  test("a member is enrolled by number, stored encrypted, and found only by the exact number", async () => {
    const res = await cashier.post(`${API}/customers`, { name: "Ayesha Khan", phone: "03001234567" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    member = res.body;
    assert.equal(member.phone, "0300-•••••67");
    const raw = JSON.stringify(await db.collection("customers").findOne({ _id: member.id }));
    assert.ok(!raw.includes("03001234567") && !raw.includes("Ayesha"), "stored encrypted");
    assert.equal((await cashier.post(`${API}/customers`, { name: "Someone", phone: "03001234567" })).body.error.code, "member_exists");
    assert.equal((await waiter.post(`${API}/customers/lookup`, { phone: "03001234567" })).body.id, member.id);
    assert.equal((await waiter.post(`${API}/customers/lookup`, { phone: "03001234568" })).status, 404);
    assert.equal((await waiter.get(`${API}/customers`)).status, 403, "only managers and admins list members");
  });

  test("a paid bill earns 1 point per Rs 100; points pay part of a later bill", async () => {
    const t = await servedTable();
    const total = calculateTotals([{ price: 890, qty: 2 }], 0, 0.16).total;
    const bill = await pay(t, { method: "Cash", tendered: 5000, customerId: member.id });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.pointsEarned, Math.floor(total / 100));
    let now = (await cashier.post(`${API}/customers/lookup`, { phone: "03001234567" })).body;
    assert.equal(now.points, Math.floor(total / 100));
    assert.equal(now.visits, 1);

    const t2 = await servedTable([{ id: 1, qty: 1 }]);
    assert.equal((await pay(t2, { method: "Points", amount: 100000, customerId: member.id })).body.error.code, "bad_amount");
    assert.equal((await pay(t2, { method: "Points", amount: now.points + 1, customerId: member.id })).body.error.code, "not_enough_points");
    const part = await pay(t2, { method: "Points", amount: 10, customerId: member.id });
    assert.equal(part.status, 201, JSON.stringify(part.body));
    assert.equal(part.body.status, "Paid");
    assert.equal(part.body.pointsSpent, 10);
    assert.equal(part.body.pointsEarned, 0, "points payments earn nothing");
    assert.equal((await pay(t2, { method: "Points", tip: 50, customerId: member.id })).body.error.code, "invalid_input");
    await pay(t2, { method: "Card" });
    now = (await cashier.post(`${API}/customers/lookup`, { phone: "03001234567" })).body;
    assert.equal(now.points, Math.floor(total / 100) - 10);
    const history = (await manager.get(`${API}/customers/${member.id}/history`)).body.history;
    assert.deepEqual(history.map((h) => h.type).sort(), ["earn", "redeem"]);
  });

  test("a refund takes back the points that bill earned", async () => {
    const t = await servedTable();
    const bill = (await pay(t, { method: "Cash", tendered: 5000, customerId: member.id })).body;
    const before = (await cashier.post(`${API}/customers/lookup`, { phone: "03001234567" })).body.points;
    await stepUp(manager);
    assert.equal((await manager.post(`${API}/bills/${bill.no}/refund`, { reason: "Wrong order" }, key())).status, 200);
    const after = (await cashier.post(`${API}/customers/lookup`, { phone: "03001234567" })).body.points;
    assert.equal(after, before - bill.pointsEarned);
  });

  test("erasing a customer's data also erases the member's name and number", async () => {
    await cashier.post(`${API}/customers`, { name: "Bilal Raza", phone: "03119998887" });
    await stepUp(admin);
    const res = await admin.post(`${API}/customers/erase`, { phone: "03119998887" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.members, 1);
    assert.equal((await cashier.post(`${API}/customers/lookup`, { phone: "03119998887" })).status, 404);
  });
});

describe("vouchers", () => {
  test("a manager creates a code; it applies a discount above the cashier's own limit, once per use", async () => {
    const res = await manager.post(`${API}/vouchers`, { code: "WELCOME20", kind: "percent", value: 20, maxUses: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await manager.post(`${API}/vouchers`, { code: "welcome20", kind: "amount", value: 100 })).status, 409);
    const t = await servedTable();
    const bill = await pay(t, { method: "Card", voucher: "WELCOME20" });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.discountPct, 20);
    assert.equal(bill.body.total, calculateTotals([{ price: 890, qty: 2 }], 20, 0.16).total);
    const t2 = await servedTable();
    assert.match((await pay(t2, { method: "Card", voucher: "WELCOME20" })).body.error.message, /used up/);
    assert.ok(await db.collection("audit_events").findOne({ action: "Voucher used" }));
    await pay(t2, { method: "Card" });
  });

  test("an amount voucher takes rupees off; minimum spend, expiry and unknown codes are refused", async () => {
    await manager.post(`${API}/vouchers`, { code: "RS200", kind: "amount", value: 200, minSpend: 1000 });
    await manager.post(`${API}/vouchers`, { code: "OLD", kind: "amount", value: 50, expiresOn: "2020-01-01" });
    const small = await servedTable([{ id: 1, qty: 1 }]);
    assert.match((await pay(small, { method: "Card", voucher: "RS200" })).body.error.message, /at least Rs 1,000/);
    assert.match((await pay(small, { method: "Card", voucher: "OLD" })).body.error.message, /expired/);
    assert.match((await pay(small, { method: "Card", voucher: "NOPE1" })).body.error.message, /not valid/);
    assert.match((await pay(small, { method: "Card", voucher: "RS200", discountPct: 5 })).body.error.message, /either a voucher or a discount/);
    await pay(small, { method: "Card" });
    const big = await servedTable();
    const bill = await pay(big, { method: "Card", voucher: "RS200" });
    assert.equal(bill.body.discount, 200);
    assert.equal(bill.body.total, calculateTotals([{ price: 890, qty: 2 }], 0, 0.16, 0, 200).total);
    assert.equal((await cashier.post(`${API}/vouchers`, { code: "MINE", kind: "percent", value: 50 })).status, 403);
  });
});

describe("booking times and tables", () => {
  test("times run through the day and are full once every suitable table is taken", async () => {
    const day = tomorrow();
    const times = (await request(app).get(`${API}/public/availability?date=${day}&party=8`)).body.times;
    assert.equal(times[0].time, "10:00");
    assert.equal(times[times.length - 1].time, "21:30");
    assert.ok(times.every((t) => t.available));
    // Only table 10 seats 8: the first booking for 8 at 19:00 takes it
    const book = (phone, time, party) => waiter.post(`${API}/reservations`, { name: "Guest Name", phone, date: day, time, party }, key());
    assert.equal((await book("03211110001", "19:00", 8)).status, 201);
    assert.equal((await book("03211110002", "19:30", 8)).body.error.code, "fully_booked", "the 8-seat table is held for 90 minutes");
    assert.equal((await book("03211110003", "20:30", 8)).status, 201, "free again after 90 minutes");
    const after = (await request(app).get(`${API}/public/availability?date=${day}&party=8`)).body.times;
    assert.equal(after.find((t) => t.time === "19:30").available, false);
    assert.equal(after.find((t) => t.time === "18:00").available, false, "18:00 would still be at the table at 19:00");
    assert.equal(after.find((t) => t.time === "17:00").available, true);
    assert.equal((await book("03211110004", "19:15", 2)).status, 400, "only times on the 30-minute steps");
  });

  test("confirming a booking gives it the smallest free table that fits", async () => {
    const day = tomorrow();
    const r = (await waiter.post(`${API}/reservations`, { name: "Party Four", phone: "03211110010", date: day, time: "12:00", party: 3 }, key())).body;
    assert.equal(r.table, 3, "table 3 is the first that seats 4");
    const seated = await waiter.post(`${API}/reservations/${r.id}/status`, { status: "Seated" });
    assert.equal(seated.body.table, 3, "seating keeps the table");
    const r2 = (await waiter.post(`${API}/reservations`, { name: "Party Two", phone: "03211110011", date: day, time: "12:30", party: 2 }, key())).body;
    assert.equal(r2.table, 1);
    assert.equal((await waiter.post(`${API}/reservations/${r2.id}/status`, { status: "Seated", table: 3 })).body.error.code, "table_booked");
    assert.equal((await waiter.post(`${API}/reservations/${r2.id}/status`, { status: "Seated", table: 2 })).body.table, 2);
    const online = await request(app).post(`${API}/public/reservations`).set("Origin", "http://localhost:3000").send({ name: "Web Guest", phone: "03211110012", date: day, time: "13:00", party: 2 });
    assert.equal(online.status, 202);
    const req = (await waiter.get(`${API}/reservations?date=${day}&status=Requested`)).body.reservations[0];
    assert.equal(req.table, null, "an online request has no table until it is confirmed");
    assert.ok((await waiter.post(`${API}/reservations/${req.id}/status`, { status: "Confirmed" })).body.table);
  });
});

describe("waitlist", () => {
  test("walk-ins wait, then are seated or leave; their number is dropped once they do", async () => {
    const added = await waiter.post(`${API}/waitlist`, { name: "Hamza", party: 3, phone: "03001112222", quotedMinutes: 20 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.phone, "0300-•••••22");
    const seated = await waiter.post(`${API}/waitlist/${added.body.id}/seat`, { table: 4 });
    assert.equal(seated.body.status, "Seated");
    assert.equal(seated.body.table, 4);
    assert.equal((await waiter.post(`${API}/waitlist/${added.body.id}/left`, {})).status, 409);
    assert.equal((await db.collection("waitlist").findOne({ _id: added.body.id })).phoneEnc, undefined);
    assert.equal((await kitchen.get(`${API}/waitlist`)).status, 403);
  });
});

describe("feedback", () => {
  test("a guest rates their visit from the website; managers see the average", async () => {
    const guest = browser(app);
    const sent = await guest.post(`${API}/public/feedback`, { rating: 5, comment: "Lovely coffee", name: "Sana" });
    assert.equal(sent.status, 202);
    await guest.post(`${API}/public/feedback`, { rating: 3, bill: "B-999999" });
    await guest.post(`${API}/public/feedback`, { rating: 1, website: "http://spam" });
    assert.equal((await guest.post(`${API}/public/feedback`, { rating: 9 })).status, 400);
    const list = (await manager.get(`${API}/feedback`)).body;
    assert.equal(list.count, 2, "the bot's rating was not saved");
    assert.equal(list.average, 4);
    assert.equal(list.items.find((f) => f.rating === 3).billNo, null, "an unknown receipt number is not linked");
    assert.equal((await cashier.get(`${API}/feedback`)).status, 403);
  });
});
