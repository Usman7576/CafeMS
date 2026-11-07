// The public website is the only part reachable without signing in, so it gets its own attack tests.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { startDb, buildApp, browser, createUser, signIn, ORIGIN } = require("./helpers");
const { seedCatalog } = require("../scripts/seed-data");
const { localDate } = require("../server/lib/domain");

const API = "/api/v1";
const PUBLIC = `${API}/public`;
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
const future = (days = 3) => localDate(Date.now() + days * 86400000);

let ctx, db, app, config;
let phoneCounter = 0;
const uniquePhone = () => `0340${String(1000000 + (phoneCounter += 1))}`;
const booking = (extra = {}) => ({ name: "Online Guest", phone: uniquePhone(), date: future(), time: "18:00", party: 2, notes: "By the window", website: "", ...extra });
const send = (body, target = app) => browser(target).post(`${PUBLIC}/reservations`, body);
const as = async (role) => signIn(app, db, await createUser(db, config, { role }));

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db, { publicBookingsPerHour: 100000 }));
});
after(() => ctx.stop());

describe("public information", () => {
  test("the menu shows only what a customer should see", async () => {
    const res = await request(app).get(`${PUBLIC}/menu`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 15);
    assert.deepEqual(Object.keys(res.body.items[0]).sort(), ["available", "cat", "desc", "hasPhoto", "id", "name", "price"]);
    const raw = JSON.stringify(res.body);
    for (const hidden of ["recipe", "qtyMilli", "reorder", "supplier"]) assert.ok(!raw.includes(hidden), hidden);
  });

  test("cafe details have safe defaults and show what an Admin saved", async () => {
    assert.equal((await request(app).get(`${PUBLIC}/info`)).body.name, "CafeMS");
    const admin = await as("Admin");
    await admin.put(`${API}/settings/cafe`, { name: "Bean There", tagline: "Hi", about: "About", address: "1 Road", phone: "0300-1234567", hours: "9 to 5" });
    const info = (await request(app).get(`${PUBLIC}/info`)).body;
    assert.equal(info.name, "Bean There");
    assert.equal(info._id, undefined);
  });

  test("public routes cannot be used to read staff data", async () => {
    for (const path of ["/users", "/bills", "/orders", "/inventory", "/audit"]) {
      assert.equal((await request(app).get(`${PUBLIC}${path}`)).status, 404, path);
    }
  });

  test("a missing photo gives 404, and a tampered ID is refused", async () => {
    assert.equal((await request(app).get(`${PUBLIC}/menu/99999/photo`)).status, 404);
    assert.equal((await request(app).get(`${PUBLIC}/menu/..%2f..%2fpackage.json/photo`)).status, 400);
  });
});

describe("online reservations", () => {
  test("a request waits for staff and stores personal data encrypted", async () => {
    const body = booking({ name: "Encrypted Name", notes: "Private request" });
    const res = await send(body);
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.id, undefined, "the reference is not given out");
    const stored = await db.collection("reservations").find().sort({ createdAt: -1 }).limit(1).next();
    assert.equal(stored.status, "Requested");
    assert.equal(stored.createdBy, "online");
    const raw = JSON.stringify(stored);
    for (const plain of ["Encrypted Name", body.phone, "Private request"]) assert.ok(!raw.includes(plain), plain);
    const event = await db.collection("audit_events").findOne({ action: "Online reservation requested", details: new RegExp(stored._id) });
    assert.ok(event);
    assert.ok(!JSON.stringify(event).includes(body.phone));
  });

  test("staff can see, confirm and search the request; the number stays masked for waiters", async () => {
    const body = booking({ name: "Confirm Me" });
    await send(body);
    const waiter = await as("Waiter");
    const list = (await waiter.get(`${API}/reservations`)).body.reservations;
    const found = list.find((r) => r.name === "Confirm Me");
    assert.equal(found.status, "Requested");
    assert.ok(!JSON.stringify(found).includes(body.phone));
    assert.equal((await waiter.post(`${API}/reservations/${found.id}/status`, { status: "Confirmed" })).status, 200);
    assert.equal((await waiter.post(`${API}/reservations/search`, { phone: body.phone })).body.reservations[0].status, "Confirmed");
  });

  test("a request queues a staff notification holding no personal data", async () => {
    const body = booking();
    await send(body);
    const message = await db.collection("outbox").find({ type: "reservation-request" }).sort({ createdAt: -1 }).limit(1).next();
    assert.ok(message.payload.reservation);
    assert.ok(!JSON.stringify(message).includes(body.phone));
  });

  test("a repeat gets the same answer, so it cannot reveal who has booked", async () => {
    const body = booking();
    const first = await send(body);
    const before = await db.collection("reservations").countDocuments();
    const second = await send(body);
    assert.deepEqual([second.status, second.body], [first.status, first.body]);
    assert.equal(await db.collection("reservations").countDocuments(), before);
  });

  test("a bot that fills the hidden field is told it worked, but nothing is saved", async () => {
    const before = await db.collection("reservations").countDocuments();
    const res = await send(booking({ website: "http://spam.example" }));
    assert.equal(res.status, 202);
    assert.equal(await db.collection("reservations").countDocuments(), before);
  });

  test("bad input is refused with a helpful message", async () => {
    const message = async (extra) => (await send(booking(extra))).body.error.message;
    assert.match(await message({ name: "A" }), /2-60/);
    assert.match(await message({ phone: "123" }), /03XXXXXXXXX/);
    assert.match(await message({ date: "2020-01-01" }), /past date/);
    assert.match(await message({ date: future(90) }), /60 days/);
    assert.match(await message({ time: "03:00" }), /between 10:00/);
    assert.match(await message({ party: 50 }), /1 to 20/);
    assert.match(await message({ notes: "x".repeat(161) }), /160/);
  });

  test("customers cannot set the status, owner or anything else", async () => {
    for (const extra of [{ status: "Confirmed" }, { createdBy: "farah.admin" }, { _id: "R-1" }, { name: { $ne: "" } }, { phone: { $gt: "" } }]) {
      assert.equal((await send(booking(extra))).status, 400, JSON.stringify(extra));
    }
  });

  test("script text in a name is stored as plain text, and shown as plain text", async () => {
    await send(booking({ name: "<script>alert(1)</script>" }));
    const manager = await as("Manager");
    const list = (await manager.get(`${API}/reservations`)).body.reservations;
    assert.ok(list.some((r) => r.name === "<script>alert(1)</script>"));
  });

  test("requests from another site are blocked", async () => {
    const res = await request(app).post(`${PUBLIC}/reservations`).set("Origin", "https://evil.example").send(booking());
    assert.equal(res.status, 403);
    assert.equal((await request(app).post(`${PUBLIC}/reservations`).send(booking())).status, 403);
  });

  test("one address can send only a limited number of requests", async () => {
    const limited = buildApp(db, { publicBookingsPerHour: 2 }).app;
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await send(booking(), limited)).status);
    assert.deepEqual(statuses, [202, 202, 429]);
  });

  test("the booking form holds no reference to staff areas beyond the sign-in link", async () => {
    const html = (await request(app).get("/")).text;
    assert.ok(!html.includes("SR-"));
    assert.ok(html.includes("login.html"));
    assert.equal((await request(app).get("/privacy.html")).status, 200);
    assert.ok(ORIGIN);
  });
});

describe("reports", () => {
  test("the 7-day trend adds up paid bills only", async () => {
    await db.collection("bills").deleteMany({});
    const base = { lines: [], status: "Paid", table: 1, orderIds: [], discount: 0, tax: 0, subtotal: 0, method: "Cash" };
    const now = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    await db.collection("bills").insertMany([
      { ...base, _id: "B-T1", createdAt: now, total: 100 },
      { ...base, _id: "B-T2", createdAt: now, total: 50 },
      { ...base, _id: "B-T3", createdAt: now, total: 999, status: "Refunded" },
      { ...base, _id: "B-T4", createdAt: yesterday, total: 70 },
      { ...base, _id: "B-T5", createdAt: new Date(Date.now() - 30 * 86400000), total: 500 }
    ]);
    const manager = await as("Manager");
    const days = (await manager.get(`${API}/reports/trend`)).body.days;
    assert.equal(days.length, 7);
    assert.deepEqual(days.at(-1), { date: localDate(), revenue: 150, bills: 2 });
    assert.equal(days.at(-2).revenue, 70);
    assert.equal(days.reduce((s, d) => s + d.revenue, 0), 220);
    assert.ok(key());
  });
});
