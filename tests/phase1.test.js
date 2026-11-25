// Phase 1 foundations: operating settings, live updates (Server-Sent Events), the sign-in policy
// (an authenticator for Admins and Managers only) and the PIN switch for shared tablets.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, browser, freshCode, PASSWORD } = require("./helpers");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
  await seedCatalog(db);
});
after(() => ctx.stop());

let n = 0;
const person = async (role, extra = {}) => {
  n += 1;
  const user = await createUser(db, config, { role, username: `${role.toLowerCase()}.p${n}`, ...extra });
  return Object.assign(await signIn(app, db, user), { username: user.username, user });
};
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
const stepUp = async (client) => assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);

describe("operating settings", () => {
  const valid = (extra = {}) => ({
    version: 0, taxRatePct: 16,
    tables: [{ no: 1, seats: 2, area: "Window" }, { no: 2, seats: 4, area: "Main hall" }, { no: 3, seats: 6, area: "Terrace" }],
    discountLimits: { Cashier: 10, Manager: 25 },
    receipt: { header: "Welcome", footer: "See you soon" },
    categories: [{ name: "Coffee", station: "Bar" }, { name: "Tea", station: "Bar" }, { name: "Cold Drinks", station: "Bar" }, { name: "Food", station: "Kitchen" }, { name: "Desserts", station: "Kitchen" }],
    orderTypes: { dineIn: true, takeaway: true, delivery: true },
    ...extra
  });

  test("an Admin reads and saves them after confirming a code; the save is audited", async () => {
    const admin = await person("Admin");
    const current = (await admin.get(`${API}/settings`)).body;
    assert.equal(current.taxRatePct, 16);
    assert.equal(current.tables.length, 10);
    assert.equal((await admin.put(`${API}/settings`, valid())).body.error.code, "step_up_required");
    await stepUp(admin);
    const saved = await admin.put(`${API}/settings`, valid({ version: current.version }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.tables.length, 3);
    assert.equal(saved.body.version, current.version + 1);
    assert.ok(await db.collection("audit_events").findOne({ action: "Settings changed", actor: admin.username }));
  });

  test("a second save with an old version is refused (no lost update)", async () => {
    const admin = await person("Admin");
    await stepUp(admin);
    const { version } = (await admin.get(`${API}/settings`)).body;
    assert.equal((await admin.put(`${API}/settings`, valid({ version, taxRatePct: 15 }))).status, 200);
    const stale = await admin.put(`${API}/settings`, valid({ version, taxRatePct: 17 }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "stale_version");
    assert.equal((await admin.get(`${API}/settings`)).body.taxRatePct, 15);
  });

  test("bad values are refused with a clear message", async () => {
    const admin = await person("Admin");
    await stepUp(admin);
    const { version } = (await admin.get(`${API}/settings`)).body;
    const cases = [
      [{ taxRatePct: 45 }, /Tax/],
      [{ tables: [] }, /at least one table/],
      [{ tables: [{ no: 1, seats: 2, area: "A" }, { no: 1, seats: 4, area: "B" }] }, /own number/],
      [{ discountLimits: { Cashier: 30, Manager: 20 } }, /cashier/i],
      [{ extra: true }, /./]
    ];
    for (const [change, message] of cases) {
      const res = await admin.put(`${API}/settings`, valid({ version, ...change }));
      assert.equal(res.status, 400, JSON.stringify(change));
      assert.match(res.body.error.message, message);
    }
  });

  test("the tax rate and tables reach the screens, and orders follow the table list", async () => {
    const admin = await person("Admin");
    await stepUp(admin);
    const { version } = (await admin.get(`${API}/settings`)).body;
    assert.equal((await admin.put(`${API}/settings`, valid({ version, taxRatePct: 10 }))).status, 200);
    const waiter = await person("Waiter");
    const snap = (await waiter.get(`${API}/snapshot`)).body;
    assert.equal(snap.constants.taxRate, 0.1);
    assert.deepEqual(snap.constants.tables.map((t) => t.no), [1, 2, 3]);
    assert.equal(snap.constants.receipt, undefined, "the waiter does not print receipts");
    const off = await waiter.post(`${API}/orders`, { table: 9, lines: [{ id: 1, qty: 1 }] }, key());
    assert.equal(off.status, 400);
    assert.match(off.body.error.message, /valid table/);
  });

  test("a table with open orders cannot be removed", async () => {
    await db.collection("orders").insertOne({ _id: "ORD-T1", table: 3, items: [], status: "Placed", waiter: "x", billed: false, createdAt: new Date(), updatedAt: new Date(), version: 0 });
    const admin = await person("Admin");
    await stepUp(admin);
    const { version } = (await admin.get(`${API}/settings`)).body;
    const res = await admin.put(`${API}/settings`, valid({ version, tables: [{ no: 1, seats: 2, area: "Window" }] }));
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "table_in_use");
    await db.collection("orders").deleteOne({ _id: "ORD-T1" });
  });

  test("only an Admin may read or change them", async () => {
    for (const role of ["Waiter", "Kitchen", "Cashier", "Manager"]) {
      const client = await person(role);
      assert.equal((await client.get(`${API}/settings`)).status, 403, role);
      assert.equal((await client.put(`${API}/settings`, valid())).status, 403, role);
    }
  });
});

// Opens the live-update stream as the browser's EventSource does, and collects what arrives
function openStream(client) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const cookie = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join("; ");
      const req = http.get({ port: server.address().port, path: `${API}/events`, headers: { Cookie: cookie, Accept: "text/event-stream" } }, (res) => {
        const stream = { status: res.statusCode, headers: res.headers, text: "", close: () => { req.destroy(); server.close(); } };
        res.setEncoding("utf8");
        res.on("data", (chunk) => { stream.text += chunk; });
        resolve(stream);
      });
      req.on("error", reject);
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("live updates", () => {
  test("a stream needs a session", async () => {
    assert.equal((await browser(app).get(`${API}/events`)).status, 401);
  });

  test("a new order reaches the kitchen as a change notice with no order data", async () => {
    const kitchen = await person("Kitchen");
    const waiter = await person("Waiter");
    const stream = await openStream(kitchen);
    try {
      assert.equal(stream.status, 200);
      assert.match(stream.headers["content-type"], /text\/event-stream/);
      const placed = await waiter.post(`${API}/orders`, { table: 1, lines: [{ id: 1, qty: 1 }] }, key());
      assert.equal(placed.status, 201, JSON.stringify(placed.body));
      await wait(400);
      assert.match(stream.text, /event: change\ndata: \{"topics":\["orders"\]\}/);
      assert.doesNotMatch(stream.text, /ORD-|price|table/i, "only the area name is sent");
    } finally {
      stream.close();
    }
  });

  test("each role hears only its own areas", async () => {
    const kitchen = await person("Kitchen");
    const admin = await person("Admin");
    const stream = await openStream(kitchen);
    try {
      await stepUp(admin);
      const { version, ...rest } = (await admin.get(`${API}/settings`)).body;
      await admin.post(`${API}/users/invitations`, { username: `new.person${n}`, name: "New Person", role: "Waiter" });
      assert.equal((await admin.put(`${API}/settings`, { ...rest, version })).status, 200);
      await wait(400);
      assert.match(stream.text, /"settings"/);
      assert.doesNotMatch(stream.text, /"users"/, "the kitchen is not told about staff changes");
    } finally {
      stream.close();
    }
  });

  test("an open stream does not keep an idle session alive", async () => {
    const waiter = await person("Waiter");
    const old = new Date(Date.now() - 60 * 1000);
    await db.collection("sessions").updateOne({ username: waiter.username }, { $set: { lastSeenAt: old } });
    const stream = await openStream(waiter);
    stream.close();
    const session = await db.collection("sessions").findOne({ username: waiter.username });
    assert.equal(session.lastSeenAt.getTime(), old.getTime());
  });
});

describe("sign-in policy", () => {
  test("a waiter without an authenticator signs in with the password alone", async () => {
    const user = await createUser(db, config, { role: "Waiter", mfa: false });
    const client = browser(app);
    const res = await client.post(`${API}/auth/login`, { username: user.username, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.next, "done");
    assert.equal((await client.get(`${API}/auth/me`)).status, 200);
  });

  test("a manager without one must add it first, and is not signed in until then", async () => {
    const user = await createUser(db, config, { role: "Manager", mfa: false });
    const client = browser(app);
    const res = await client.post(`${API}/auth/login`, { username: user.username, password: PASSWORD });
    assert.equal(res.body.next, "enroll");
    assert.equal((await client.get(`${API}/auth/me`)).status, 401);
  });

  test("a waiter who has an authenticator is still asked for it", async () => {
    const user = await createUser(db, config, { role: "Waiter" });
    const res = await browser(app).post(`${API}/auth/login`, { username: user.username, password: PASSWORD });
    assert.equal(res.body.next, "mfa");
  });
});

describe("PIN switch on a shared tablet", () => {
  const setPin = (client, pin) => client.put(`${API}/auth/pin`, { currentPassword: PASSWORD, pin });

  test("a PIN needs the password, must be 4-6 digits and not easy to guess, and is stored hashed", async () => {
    const waiter = await person("Waiter");
    assert.equal((await waiter.put(`${API}/auth/pin`, { currentPassword: "wrong-password", pin: "4829" })).status, 400);
    assert.equal((await setPin(waiter, "12")).status, 400);
    assert.equal((await setPin(waiter, "1234")).body.error.code, "weak_pin");
    assert.equal((await setPin(waiter, "7777")).body.error.code, "weak_pin");
    assert.equal((await setPin(waiter, "4829")).status, 204);
    const stored = await db.collection("users").findOne({ username: waiter.username });
    assert.match(stored.pin.hash, /^\$argon2id\$/);
  });

  test("Admins and Managers cannot set a PIN", async () => {
    for (const role of ["Admin", "Manager"]) assert.equal((await setPin(await person(role), "4829")).status, 403, role);
  });

  test("switching ends the tablet's session and starts the other person's", async () => {
    const tablet = await person("Waiter");
    const cashier = await person("Cashier");
    assert.equal((await setPin(cashier, "5172")).status, 204);
    const people = (await tablet.get(`${API}/auth/switch/people`)).body.people;
    assert.ok(people.some((p) => p.username === cashier.username));
    const before = tablet.jar["__Host-cms_session"];
    const res = await tablet.post(`${API}/auth/switch`, { username: cashier.username, pin: "5172" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.role, "Cashier");
    assert.notEqual(tablet.jar["__Host-cms_session"], before);
    await tablet.loadCsrf();
    assert.equal((await tablet.get(`${API}/auth/me`)).body.username, cashier.username);
    // The old session is gone for good
    const replay = browser(app);
    replay.jar["__Host-cms_session"] = before;
    assert.equal((await replay.get(`${API}/auth/me`)).status, 401);
    assert.ok(await db.collection("audit_events").findOne({ actor: cashier.username, details: { $regex: "PIN switch" } }));
  });

  test("five wrong PINs pause PIN sign-in for that person, even with the right PIN after", async () => {
    const tablet = await person("Waiter");
    const kitchen = await person("Kitchen");
    await setPin(kitchen, "6391");
    for (let i = 0; i < 5; i++) assert.equal((await tablet.post(`${API}/auth/switch`, { username: kitchen.username, pin: "0000" })).status, 401);
    const locked = await tablet.post(`${API}/auth/switch`, { username: kitchen.username, pin: "6391" });
    assert.equal(locked.status, 401);
    assert.ok(await db.collection("audit_events").findOne({ action: "PIN locked", actor: kitchen.username }));
  });

  test("nobody can switch into a Manager or an unknown person, and the answer is the same", async () => {
    const tablet = await person("Waiter");
    const manager = await person("Manager");
    await db.collection("users").updateOne({ username: manager.username }, { $set: { pin: { hash: (await db.collection("users").findOne({ pin: { $exists: true } })).pin.hash } } });
    const a = await tablet.post(`${API}/auth/switch`, { username: manager.username, pin: "4829" });
    const b = await tablet.post(`${API}/auth/switch`, { username: "nobody.here", pin: "4829" });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.message, b.body.error.message);
  });

  test("switching needs a signed-in tablet", async () => {
    assert.equal((await browser(app).post(`${API}/auth/switch`, { username: "x", pin: "4829" })).status, 401);
  });
});
