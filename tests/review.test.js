// Regression tests for weaknesses found in the review of Phases 1 to 4.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Writable } = require("stream");
const authenticator = require("../server/lib/totp");
const { startDb, buildApp, browser, createUser, signIn, freshCode, testConfig, PASSWORD } = require("./helpers");
const { seedCatalog } = require("../scripts/seed-data");
const { createApp } = require("../server/app");
const { createLogger } = require("../server/lib/logger");
const { purgeExpiredData } = require("../server/services/customers");

const API = "/api/v1";
const PHONE = "03451239876";
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });

let ctx, db, app, config;
async function as(role) {
  const user = await createUser(db, config, { role });
  const client = await signIn(app, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

describe("personal data must not leak by other routes", () => {
  test("searching by phone uses the request body, so the number never reaches URLs or logs", async () => {
    const waiter = await as("Waiter");
    const made = await waiter.post(`${API}/reservations`, { name: "Search Me", phone: PHONE, date: "2099-03-01", time: "12:00", party: 2 }, key());
    const found = await waiter.post(`${API}/reservations/search`, { phone: PHONE });
    assert.deepEqual(found.body.reservations.map((r) => r.id), [made.body.id]);
    assert.equal((await waiter.get(`${API}/reservations?phone=${PHONE}`)).status, 400);
  });

  test("the saved response for a repeated request holds no guest name or notes in plain text", async () => {
    const waiter = await as("Waiter");
    const same = key();
    const body = { name: "Very Private Guest", phone: "03451110000", date: "2099-03-02", time: "13:00", party: 2, notes: "Secret anniversary" };
    const first = await waiter.post(`${API}/reservations`, body, same);
    assert.equal(first.body.name, "Very Private Guest");
    const raw = JSON.stringify(await db.collection("idempotency").find().toArray());
    assert.ok(!raw.includes("Very Private Guest"));
    assert.ok(!raw.includes("Secret anniversary"));
    const repeat = await waiter.post(`${API}/reservations`, body, same);
    assert.equal(repeat.body.id, first.body.id);
    assert.equal(repeat.body.name, "Very Private Guest");
  });

  test("logs hold no cookies, tokens, passwords or codes", async () => {
    const lines = [];
    const destination = new Writable({ write(chunk, _enc, done) { lines.push(chunk.toString()); done(); } });
    const logConfig = { ...testConfig(), audit: config.audit, data: config.data };
    const logged = createApp({ config: logConfig, db, logger: createLogger({ ...logConfig, env: "development" }, destination) });
    const user = await createUser(db, logConfig, { role: "Waiter" });
    const client = await signIn(logged, db, user);
    const code = await freshCode(db, user);
    await client.post(`${API}/auth/step-up`, { code });
    await client.post(`${API}/auth/logout`, {});
    const output = lines.join("");
    assert.ok(output.length > 100, "something was logged");
    for (const secret of ["__Host-", user.password, code, "eyJ"]) assert.ok(!output.includes(secret), `log contains ${secret}`);
  });
});

describe("a reset must end every sign-in in progress", () => {
  async function enrolChallenge() {
    const user = await createUser(db, config, { mfa: false, role: "Waiter" });
    const attacker = browser(app);
    await attacker.post(`${API}/auth/login`, { username: user.username, password: user.password });
    const start = await attacker.post(`${API}/auth/mfa/enroll/start`, {});
    return { user, attacker, secret: start.body.manualKey };
  }

  test("a half-finished enrolment cannot create a session after an Admin reset", async () => {
    const { user, attacker, secret } = await enrolChallenge();
    const admin = await as("Admin");
    await stepUp(admin);
    assert.equal((await admin.post(`${API}/users/${user.username}/reset-link`, {})).status, 201);
    const res = await attacker.post(`${API}/auth/mfa/enroll/confirm`, { code: authenticator.generate(secret) });
    assert.equal(res.status, 401);
    assert.equal((await db.collection("sessions").countDocuments({ username: user.username })), 0);
  });

  test("a half-finished enrolment cannot create a session after the account is disabled", async () => {
    const { user, attacker, secret } = await enrolChallenge();
    const admin = await as("Admin");
    await stepUp(admin);
    await admin.post(`${API}/users/${user.username}/status`, { status: "Disabled" });
    assert.equal((await attacker.post(`${API}/auth/mfa/enroll/confirm`, { code: authenticator.generate(secret) })).status, 401);
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.equal(stored.mfa.enabled, false);
  });

  test("an old enrolment cannot replace an authenticator that is already set up", async () => {
    const { user, attacker, secret } = await enrolChallenge();
    const owner = browser(app);
    await owner.post(`${API}/auth/login`, { username: user.username, password: user.password });
    const ownerStart = await owner.post(`${API}/auth/mfa/enroll/start`, {});
    assert.equal((await owner.post(`${API}/auth/mfa/enroll/confirm`, { code: authenticator.generate(ownerStart.body.manualKey) })).status, 200);
    const before = (await db.collection("users").findOne({ username: user.username })).mfa.secretEnc;
    assert.equal((await attacker.post(`${API}/auth/mfa/enroll/confirm`, { code: authenticator.generate(secret) })).status, 401);
    assert.equal((await db.collection("users").findOne({ username: user.username })).mfa.secretEnc, before);
  });

  test("changing a password ends other sign-ins in progress", async () => {
    const user = await createUser(db, config, { role: "Waiter" });
    const owner = await signIn(app, db, user);
    const attacker = browser(app);
    await attacker.post(`${API}/auth/login`, { username: user.username, password: PASSWORD });
    assert.equal((await owner.post(`${API}/auth/password`, { currentPassword: PASSWORD, newPassword: "Another-Strong-Pass-61!" })).status, 204);
    assert.equal((await attacker.post(`${API}/auth/mfa/verify`, { code: await freshCode(db, user) })).body.error.code, "challenge_expired");
  });

  test("disabling an account cancels its invitation link", async () => {
    const admin = await as("Admin");
    await stepUp(admin);
    const link = (await admin.post(`${API}/users/invitations`, { username: "cancel.link", name: "Cancel Link", role: "Waiter" })).body.setupUrl;
    await admin.post(`${API}/users/cancel.link/status`, { status: "Disabled" });
    await admin.post(`${API}/users/cancel.link/status`, { status: "Active" });
    const res = await browser(app).post(`${API}/auth/setup`, { token: link.split("#token=")[1], password: "Brand-New-Pass-42!" });
    assert.equal(res.body.error.code, "bad_setup_link");
  });
});

describe("payments", () => {
  async function servedTable(waiter, kitchen, table) {
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    const order = (await waiter.post(`${API}/orders`, { table, lines: [{ id: 1, qty: 1 }] }, key())).body;
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
    await waiter.post(`${API}/orders/${order.id}/serve`, {});
  }

  test("a double click or a retry during a slow charge cannot charge the customer twice", async () => {
    let charges = 0;
    const gateway = { charge: (c) => new Promise((resolve) => { charges += 1; setTimeout(() => resolve({ status: "approved", reference: c.reference, amount: c.amount, gatewayRef: "ONE" }), 200); }) };
    const single = buildApp(db, {}, gateway);
    const person = async (role) => {
      const user = await createUser(db, single.config, { role });
      const client = await signIn(single.app, db, user);
      return client;
    };
    const [waiter, kitchen, cashier] = [await person("Waiter"), await person("Kitchen"), await person("Cashier")];
    await servedTable(waiter, kitchen, 8);
    const same = key();
    const url = `${API}/billing/tables/8/pay`;
    const [a, b] = await Promise.all([cashier.post(url, { method: "Card" }, same), cashier.post(url, { method: "Card" }, same)]);
    assert.equal(a.body.no, b.body.no);
    assert.equal(charges, 1);
    const stored = await db.collection("bills").findOne({ _id: a.body.no });
    assert.equal(stored.status, "Paid");
  });

  test("failed callbacks count towards the rate limit, so they cannot flood the audit log", async () => {
    const limited = buildApp(db, { authPer15Minutes: 2 }).app;
    const send = () => browser(limited).post(`${API}/payments/callback`, { reference: "B-1", amount: 1, status: "approved", gatewayRef: "X" });
    const statuses = [(await send()).status, (await send()).status, (await send()).status];
    assert.deepEqual(statuses, [401, 401, 429]);
  });
});

test("the erased time is the real time, not when the server started", async () => {
  const old = new Date(Date.now() - 100 * 86400000);
  await db.collection("bills").insertOne({ _id: "B-TIME", createdAt: old, total: 1, phoneEnc: "x", phoneIndex: "t", phoneMask: "m", status: "Paid", lines: [] });
  const started = Date.now();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  await purgeExpiredData(db, 90);
  const stored = await db.collection("bills").findOne({ _id: "B-TIME" });
  assert.ok(stored.customerErasedAt.getTime() >= started);
  await db.collection("bills").deleteOne({ _id: "B-TIME" });
});
