// Fixes from the review of Phases 1-4, and tests for plan findings that had no labelled test before.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { startDb, buildApp, browser, createUser, freshCode, signIn } = require("./helpers");
const { passwordProblems, verifyPassword } = require("../server/lib/passwords");
const { callbackSignature } = require("../server/services/gateway");
const { createAlertService } = require("../server/services/alerts");
const { loadConfig } = require("../server/config");
const { createShutdown } = require("../server/lifecycle");
const { testEnv } = require("./helpers");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role, target = { app, config }) {
  const user = await createUser(db, target.config, { role });
  const client = await signIn(target.app, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}
let billCounter = 9000;
async function insertBill(extra = {}) {
  billCounter += 1;
  const bill = {
    _id: `B-${billCounter}`, table: 1, orderIds: [], lines: [], discountPct: 0, subtotal: 100, discount: 0, tax: 16, total: 116,
    method: "Card", tendered: 116, change: 0, cashier: "someone", createdAt: new Date(), status: "Paid", ...extra
  };
  await db.collection("bills").insertOne(bill);
  return bill;
}
function sendCallback(body, target = app, cfg = config) {
  const timestamp = String(Date.now());
  const signature = callbackSignature(cfg.gateway.secret, timestamp, body);
  return browser(target).post(`${API}/payments/callback`, body, { origin: null, headers: { "x-gateway-timestamp": timestamp, "x-gateway-signature": signature } });
}

// Makes every audit write fail, as a full disk or a lost permission would
async function withAuditDown(work) {
  await db.command({ collMod: "audit_events", validator: { blockedForTest: { $exists: true } }, validationLevel: "strict", validationAction: "error" });
  try {
    return await work();
  } finally {
    await db.command({ collMod: "audit_events", validator: {}, validationLevel: "off" });
  }
}

describe("passwords people commonly choose are refused", () => {
  test("a common word dressed up with capitals, digits and symbols does not pass", () => {
    for (const p of ["Password123!", "P@ssw0rd2024", "Admin@1234567", "Cafems@12345", "Welcome@12345", "Qwerty@123456", "123Welcome!!", "PasswordPassword1!"]) {
      assert.ok(passwordProblems(p, "someone").some((m) => /too common/.test(m)), p);
    }
  });

  test("strong passwords still pass", () => {
    for (const p of ["Correct-Horse-7-Battery", "Blue-Kettle-42-River", "Xy!29581047#"]) assert.deepEqual(passwordProblems(p, "someone"), [], p);
  });

  test("the server refuses one when a person changes their password", async () => {
    const waiter = await as("Waiter");
    const res = await waiter.post(`${API}/auth/password`, { currentPassword: waiter.user.password, newPassword: "Password123!" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "weak_password");
  });
});

describe("an action that cannot be recorded does not happen (fail-secure audit)", () => {
  test("cafe details", async () => {
    const admin = await as("Admin");
    const before = (await admin.get(`${API}/public/info`)).body.name;
    const res = await withAuditDown(() => admin.put(`${API}/settings/cafe`, { name: "Changed Without A Record", tagline: "", about: "", address: "", phone: "", hours: "" }));
    assert.equal(res.status, 500);
    assert.equal((await admin.get(`${API}/public/info`)).body.name, before);
  });

  test("a password change", async () => {
    const waiter = await as("Waiter");
    const res = await withAuditDown(() => waiter.post(`${API}/auth/password`, { currentPassword: waiter.user.password, newPassword: "Fresh-Kettle-99-River" }));
    assert.equal(res.status, 500);
    const stored = await db.collection("users").findOne({ username: waiter.user.username });
    assert.equal(await verifyPassword(stored.passwordHash, waiter.user.password), true);
  });

  test("unlocking an account and acknowledging an alert", async () => {
    const admin = await as("Admin");
    const locked = await createUser(db, config, { role: "Waiter" });
    await db.collection("users").updateOne({ username: locked.username }, { $set: { lockedUntil: new Date(Date.now() + 600000) } });
    const alertId = crypto.randomBytes(12).toString("hex");
    await db.collection("alerts").insertOne({ _id: alertId, key: `test:${alertId}`, status: "Open", title: "Test", createdAt: new Date(), lastSeenAt: new Date() });
    await stepUp(admin);
    const [unlock, ack] = await withAuditDown(async () => [
      await admin.post(`${API}/users/${locked.username}/unlock`, {}),
      await admin.post(`${API}/alerts/${alertId}/acknowledge`, {})
    ]);
    assert.equal(unlock.status, 500);
    assert.equal(ack.status, 500);
    assert.ok((await db.collection("users").findOne({ username: locked.username })).lockedUntil > new Date());
    assert.equal((await db.collection("alerts").findOne({ _id: alertId })).status, "Open");
  });

  test("signing in", async () => {
    const user = await createUser(db, config);
    const client = browser(app);
    await client.post(`${API}/auth/login`, { username: user.username, password: user.password });
    const code = await freshCode(db, user);
    const res = await withAuditDown(() => client.post(`${API}/auth/mfa/verify`, { code }));
    assert.equal(res.status, 500);
    assert.equal(await db.collection("sessions").countDocuments({ username: user.username }), 0);
    assert.ok(!(res.headers["set-cookie"] || []).some((c) => c.startsWith("__Host-cms_session=") && !c.startsWith("__Host-cms_session=;")));
  });
});

describe("a customer cannot be charged twice", () => {
  test("no second payment is taken while a card charge is still waiting for the gateway", async () => {
    const gate = {};
    const slow = { charge: ({ reference, amount }) => new Promise((resolve) => { gate.release = () => resolve({ status: "approved", reference, amount, gatewayRef: "SLOW-1" }); }) };
    const built = buildApp(db, {}, slow);
    const bill = await insertBill({ status: "Pending Payment" });
    const cashier = await as("Cashier", built);
    const charging = cashier.post(`${API}/bills/${bill._id}/retry-payment`, { method: "Card" });
    for (let i = 0; i < 50 && !gate.release; i++) await new Promise((r) => setTimeout(r, 20));
    const cash = await cashier.post(`${API}/bills/${bill._id}/retry-payment`, { method: "Cash", tendered: 116 });
    assert.equal(cash.status, 409);
    assert.equal(cash.body.error.code, "charge_in_progress");
    gate.release();
    assert.equal((await charging).body.status, "Paid");
    assert.equal((await db.collection("bills").findOne({ _id: bill._id })).method, "Card");
  });

  test("a late approval for a bill already paid another way is recorded and raises an alert", async () => {
    const bill = await insertBill({ status: "Paid", method: "Cash" });
    const res = await sendCallback({ reference: bill._id, amount: 116, status: "approved", gatewayRef: "LATE-1" });
    assert.equal(res.status, 204);
    assert.equal((await db.collection("bills").findOne({ _id: bill._id })).method, "Cash");
    assert.ok(await db.collection("audit_events").findOne({ action: "Payment conflict", details: new RegExp(bill._id), severity: "high" }));
    await createAlertService({ db }).evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "payment-conflict", status: "Open" }));
  });

  test("a copied gateway callback is accepted only once", async () => {
    const bill = await insertBill({ status: "Pending Payment" });
    const body = { reference: bill._id, amount: 116, status: "declined", gatewayRef: "COPY-1" };
    const timestamp = String(Date.now());
    const headers = { "x-gateway-timestamp": timestamp, "x-gateway-signature": callbackSignature(config.gateway.secret, timestamp, body) };
    const send = () => browser(app).post(`${API}/payments/callback`, body, { origin: null, headers });
    assert.equal((await send()).status, 204);
    await db.collection("bills").updateOne({ _id: bill._id }, { $set: { status: "Pending Payment" } });
    const replay = await send();
    assert.equal(replay.status, 409);
    assert.equal((await db.collection("bills").findOne({ _id: bill._id })).status, "Pending Payment");
    assert.ok(await db.collection("audit_events").findOne({ action: "Gateway callback replayed", details: bill._id }));
  });
});

describe("refunds", () => {
  test("need a fresh authenticator code as well as the Manager role", async () => {
    const bill = await insertBill();
    const manager = await as("Manager");
    const first = await manager.post(`${API}/bills/${bill._id}/refund`, { reason: "Wrong item" }, key());
    assert.equal(first.status, 403);
    assert.equal(first.body.error.code, "step_up_required");
    assert.equal((await db.collection("bills").findOne({ _id: bill._id })).status, "Paid");
    await stepUp(manager);
    assert.equal((await manager.post(`${API}/bills/${bill._id}/refund`, { reason: "Wrong item" }, key())).body.status, "Refunded");
  });
});

describe("bills", () => {
  test("a cashier cannot open a past day's bill by its number; a manager can", async () => {
    const old = await insertBill({ createdAt: new Date("2024-01-01T08:00:00Z") });
    const today = await insertBill();
    const cashier = await as("Cashier");
    assert.equal((await cashier.get(`${API}/bills/${old._id}`)).status, 404);
    assert.equal((await cashier.get(`${API}/bills/${today._id}`)).status, 200);
    assert.equal((await (await as("Manager")).get(`${API}/bills/${old._id}`)).status, 200);
  });

  test("impossible dates are refused instead of returning an empty day", async () => {
    const manager = await as("Manager");
    for (const url of ["/reports/sales?date=2026-99-99", "/bills?date=2026-02-30", "/reports/sales.csv?date=2026-13-01", "/reservations?date=2026-00-10"]) {
      assert.equal((await manager.get(`${API}${url}`)).status, 400, url);
    }
    const booking = await manager.post(`${API}/reservations`, { name: "Guest", phone: "03001230000", date: "2030-02-30", time: "12:00", party: 2 }, key());
    assert.equal(booking.status, 400);
  });
});

describe("reservations", () => {
  test("a new booking still appears on the staff screen after hundreds of old ones", async () => {
    const old = Array.from({ length: 520 }, (_, i) => ({ _id: `R-OLD${i}`, phoneMask: "", date: "2021-01-01", time: "12:00", party: 2, status: "Completed", active: false, createdAt: new Date(), createdBy: "x", erasedAt: new Date() }));
    await db.collection("reservations").insertMany(old);
    const manager = await as("Manager");
    const made = await manager.post(`${API}/reservations`, { name: "New Guest", phone: "03001112223", date: "2030-01-01", time: "12:00", party: 2 }, key());
    assert.equal(made.status, 201);
    const listed = (await manager.get(`${API}/snapshot`)).body.reservations;
    assert.ok(listed.some((r) => r.id === made.body.id));
    assert.ok(!listed.some((r) => r.id.startsWith("R-OLD")));
    await db.collection("reservations").deleteMany({ _id: /^R-OLD/ });
  });

  test("a reservation whose guest was erased cannot be reopened", async () => {
    await db.collection("reservations").insertOne({ _id: "R-77001", phoneMask: "", date: "2030-03-03", time: "12:00", party: 2, status: "Confirmed", active: false, createdAt: new Date(), createdBy: "x", erasedAt: new Date() });
    const res = await (await as("Manager")).post(`${API}/reservations/R-77001/status`, { status: "Seated" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "erased");
  });

  test("the snapshot always holds a reservation list, even when there are none (finding 29)", async () => {
    const list = (await (await as("Waiter")).get(`${API}/snapshot`)).body.reservations;
    assert.ok(Array.isArray(list));
  });
});

describe("monitoring", () => {
  test("one password tried against many usernames from one address raises an alert (password spraying)", async () => {
    for (let i = 0; i < 12; i++) await browser(app).post(`${API}/auth/login`, { username: `spray.user${i}`, password: "Wrong-Password-1" });
    await createAlertService({ db }).evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "failed-sign-ins-address", status: "Open" }));
  });
});

describe("request limits", () => {
  test("each signed-in person has a limit, so one person cannot use up a shared cafe address", async () => {
    const built = buildApp(db, { userPerMinute: 3 });
    const busy = await as("Waiter", built);
    const other = await as("Waiter", built);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await busy.get(`${API}/tables`)).status);
    assert.equal(codes.at(-1), 429);
    assert.equal((await other.get(`${API}/tables`)).status, 200);
  });

  test("the address limit leaves room for a full shift of staff screens on one Wi-Fi", () => {
    const limits = loadConfig(testEnv()).limits;
    const screens = 20;
    const requestsPerScreen = 20 + 4; // a refresh every 3 seconds plus activity
    assert.ok(limits.apiPerMinute >= screens * requestsPerScreen);
    assert.ok(limits.userPerMinute >= requestsPerScreen * 2);
  });

  test("pages and health checks are limited too", async () => {
    const built = buildApp(db, { sitePerMinute: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await browser(built.app).get("/api/health/live")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  });
});

describe("sessions", () => {
  test("the device list hides and removes sessions that have already timed out", async () => {
    const user = await createUser(db, config);
    await signIn(app, db, user);
    const current = await signIn(app, db, user);
    await db.collection("sessions").updateOne({ username: user.username, lastSeenAt: { $exists: true } }, { $set: { lastSeenAt: new Date(Date.now() - 3600000) } });
    const list = (await current.get(`${API}/auth/sessions`)).body.sessions;
    assert.equal(list.length, 1);
    assert.equal(list[0].current, true);
    assert.equal(await db.collection("sessions").countDocuments({ username: user.username }), 1);
  });

  test("a deleted account's open session cannot take a payment (finding 28)", async () => {
    const cashier = await as("Cashier");
    await db.collection("users").deleteOne({ username: cashier.user.username });
    assert.equal((await cashier.post(`${API}/billing/tables/1/pay`, { method: "Cash", tendered: 1000 }, key())).status, 401);
  });
});

describe("project files", () => {
  const root = path.join(__dirname, "..");

  test("no static-hosting config publishes the server code (finding 19)", () => {
    assert.equal(fs.existsSync(path.join(root, "netlify.toml")), false);
  });

  test("the packages npm audit flagged are on fixed versions (finding 17)", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const atLeast = (version, minimum) => {
      const a = version.split(".").map(Number);
      const b = minimum.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return true;
    };
    assert.ok(atLeast(lock.packages["node_modules/body-parser"].version, "1.20.3"));
    assert.ok(atLeast(lock.packages["node_modules/qs"].version, "6.13.0"));
  });

  test("the privacy notice tells customers what the security log keeps", () => {
    const notice = fs.readFileSync(path.join(root, "public", "privacy.html"), "utf8");
    assert.match(notice, /network address/);
  });

  test("personal data is encrypted in the database, never stored as plain text (finding 14)", async () => {
    const manager = await as("Manager");
    const made = await manager.post(`${API}/reservations`, { name: "Plain Text Check", phone: "03004445556", date: "2030-04-04", time: "13:00", party: 2, notes: "Window seat" }, key());
    const stored = JSON.stringify(await db.collection("reservations").findOne({ _id: made.body.id }));
    for (const value of ["Plain Text Check", "03004445556", "Window seat"]) assert.ok(!stored.includes(value), value);
  });
});

describe("browser hardening found by the ZAP scan", () => {
  test("every form posts, so a password or number can never end up in a URL or access log", () => {
    const dir = path.join(__dirname, "..", "public");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      for (const form of fs.readFileSync(path.join(dir, file), "utf8").match(/<form [^>]*>/g) || []) {
        assert.match(form, /method="post"/, `${file}: ${form}`);
      }
    }
  });

  test("a form that posts without JavaScript reaches nothing, and pages cannot be framed or embed other sites", async () => {
    assert.equal((await browser(app).post("/login.html", { username: "a", password: "b" })).status, 404);
    const page = await browser(app).get("/login.html");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["cross-origin-embedder-policy"], "require-corp");
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  });
});

describe("encryption", () => {
  test("a shortened GCM authentication tag is refused, so forged values cannot be accepted", () => {
    const { encrypt, decrypt } = require("../server/lib/crypto");
    const value = encrypt("03001234567", "test:1", config.data);
    assert.equal(decrypt(value, "test:1", config.data), "03001234567");
    const parts = value.split(".");
    parts[3] = Buffer.from(parts[3], "base64url").subarray(0, 4).toString("base64url");
    assert.throws(() => decrypt(parts.join("."), "test:1", config.data));
  });
});

describe("graceful shutdown", () => {
  test("a request in progress finishes, then the database closes and the process exits cleanly", async () => {
    let finish;
    const server = http.createServer((_req, res) => { finish = () => res.end("done"); });
    await new Promise((r) => server.listen(0, r));
    const events = [];
    const exited = new Promise((resolve) => {
      const stop = createShutdown({
        server, stopWorkers: () => events.push("workers"), client: { close: async () => events.push("db") },
        exit: (code) => { events.push(`exit ${code}`); resolve(); }, forceAfterMs: 5000
      });
      const reply = new Promise((done) => http.get(`http://127.0.0.1:${server.address().port}/`, (res) => { res.resume(); res.on("end", () => done(res.statusCode)); }));
      const waitForRequest = async () => { while (!finish) await new Promise((r) => setTimeout(r, 10)); };
      waitForRequest().then(() => {
        assert.equal(stop(), true);
        assert.equal(stop(), false);
        events.push("request finishing");
        finish();
        return reply;
      }).then((status) => events.push(`reply ${status}`));
    });
    await exited;
    assert.deepEqual(events.filter((e) => e !== "reply 200"), ["workers", "request finishing", "db", "exit 0"]);
  });

  test("a stuck request cannot stop the process from exiting", async () => {
    const server = { close: () => {}, closeIdleConnections: () => {} };
    const code = await new Promise((resolve) => createShutdown({ server, client: { close: async () => {} }, stopWorkers: () => {}, exit: resolve, forceAfterMs: 30 })());
    assert.equal(code, 1);
  });
});
