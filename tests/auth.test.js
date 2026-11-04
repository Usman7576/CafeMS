const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const { startDb, buildApp, browser, createUser, freshCode, signIn, PASSWORD } = require("./helpers");
const { hashToken } = require("../server/lib/crypto");
const { SESSION_COOKIE } = require("../server/services/sessions");

let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const LOGIN = "/api/v1/auth/login";
const VERIFY = "/api/v1/auth/mfa/verify";
const ME = "/api/v1/auth/me";

describe("password step", () => {
  test("a wrong password is refused, even though it meets the rules (finding 1)", async () => {
    const user = await createUser(db, config);
    const res = await browser(app).post(LOGIN, { username: user.username, password: "Another-Valid-Pass-1" });
    assert.equal(res.status, 401);
  });

  test("unknown, disabled and wrong-password failures look identical", async () => {
    const known = await createUser(db, config);
    const disabled = await createUser(db, config, { status: "Disabled" });
    const results = await Promise.all([
      browser(app).post(LOGIN, { username: known.username, password: "Wrong-Password-99!" }),
      browser(app).post(LOGIN, { username: "nobody.here", password: PASSWORD }),
      browser(app).post(LOGIN, { username: disabled.username, password: PASSWORD })
    ]);
    const shape = (r) => ({ status: r.status, code: r.body.error.code, message: r.body.error.message });
    assert.deepEqual(shape(results[0]), shape(results[1]));
    assert.deepEqual(shape(results[0]), shape(results[2]));
  });

  test("NoSQL operator objects are refused", async () => {
    for (const body of [{ username: { $ne: null }, password: { $ne: null } }, { username: "a", password: "b", role: "Admin" }]) {
      const res = await browser(app).post(LOGIN, body);
      assert.equal(res.status, 401);
    }
  });

  test("passwords are stored only as Argon2id hashes", async () => {
    const user = await createUser(db, config);
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.match(stored.passwordHash, /^\$argon2id\$/);
    assert.ok(!JSON.stringify(stored).includes(PASSWORD));
  });

  test("a correct password alone gives no session (MFA is mandatory)", async () => {
    const user = await createUser(db, config);
    const client = browser(app);
    const res = await client.post(LOGIN, { username: user.username, password: user.password });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { next: "mfa" });
    assert.equal(client.jar[SESSION_COOKIE], undefined);
    assert.equal((await client.get(ME)).status, 401);
  });
});

describe("lockout (finding 12)", () => {
  async function fail(username, times) {
    for (let i = 0; i < times; i++) await browser(app).post(LOGIN, { username, password: "Wrong-Password-99!" });
  }

  test("3 failures lock the account, and the right password is then refused", async () => {
    const user = await createUser(db, config);
    await fail(user.username, 3);
    const res = await browser(app).post(LOGIN, { username: user.username, password: user.password });
    assert.equal(res.status, 401);
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.ok(stored.lockedUntil > new Date());
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Account locked" }));
  });

  test("a new browser cannot reset the lock", async () => {
    const user = await createUser(db, config);
    await fail(user.username, 3);
    const res = await browser(app).post(LOGIN, { username: user.username, password: user.password });
    assert.equal(res.status, 401);
  });

  test("the lock ends after its time has passed", async () => {
    const user = await createUser(db, config);
    await fail(user.username, 3);
    await db.collection("users").updateOne({ username: user.username }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    const res = await browser(app).post(LOGIN, { username: user.username, password: user.password });
    assert.equal(res.status, 200);
  });

  test("a successful sign-in resets the failure count", async () => {
    const user = await createUser(db, config);
    await fail(user.username, 2);
    await browser(app).post(LOGIN, { username: user.username, password: user.password });
    await fail(user.username, 2);
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.equal(stored.lockedUntil, null);
  });

  test("wrong MFA codes also count towards the lock", async () => {
    const user = await createUser(db, config);
    const client = browser(app);
    await client.post(LOGIN, { username: user.username, password: user.password });
    for (let i = 0; i < 3; i++) await client.post(VERIFY, { code: "000000" });
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.ok(stored.lockedUntil > new Date());
  });
});

describe("MFA", () => {
  test("a correct code creates a session and sets a hardened cookie", async () => {
    const user = await createUser(db, config, { role: "Cashier" });
    const client = browser(app);
    await client.post(LOGIN, { username: user.username, password: user.password });
    const res = await client.post(VERIFY, { code: await freshCode(db, user) });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, "Cashier");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith(SESSION_COOKIE));
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(cookie.includes(flag), flag);
    assert.equal((await client.get(ME)).body.username, user.username);
  });

  test("a code cannot be used twice", async () => {
    const user = await createUser(db, config);
    const code = await freshCode(db, user);
    const first = browser(app);
    await first.post(LOGIN, { username: user.username, password: user.password });
    assert.equal((await first.post(VERIFY, { code })).status, 200);
    const second = browser(app);
    await second.post(LOGIN, { username: user.username, password: user.password });
    assert.equal((await second.post(VERIFY, { code })).status, 401);
  });

  test("a code without a password step is refused", async () => {
    const user = await createUser(db, config);
    const res = await browser(app).post(VERIFY, { code: await freshCode(db, user) });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "challenge_expired");
  });

  test("a recovery code works exactly once", async () => {
    const code = "ABCDE-FGH23";
    const user = await createUser(db, config, { recoveryHashes: [hashToken(code)] });
    const first = browser(app);
    await first.post(LOGIN, { username: user.username, password: user.password });
    assert.equal((await first.post(VERIFY, { recoveryCode: code })).status, 200);
    const second = browser(app);
    await second.post(LOGIN, { username: user.username, password: user.password });
    assert.equal((await second.post(VERIFY, { recoveryCode: code })).status, 401);
  });

  test("first sign-in forces enrolment; secret is encrypted and codes are hashed", async () => {
    const user = await createUser(db, config, { mfa: false });
    const client = browser(app);
    assert.deepEqual((await client.post(LOGIN, { username: user.username, password: user.password })).body, { next: "enroll" });
    assert.equal(client.jar[SESSION_COOKIE], undefined);

    const start = await client.post("/api/v1/auth/mfa/enroll/start", {});
    assert.match(start.body.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal((await client.post("/api/v1/auth/mfa/enroll/confirm", { code: "000000" })).status, 401);

    const done = await client.post("/api/v1/auth/mfa/enroll/confirm", { code: authenticator.generate(start.body.manualKey) });
    assert.equal(done.status, 200);
    assert.equal(done.body.recoveryCodes.length, 10);

    const stored = await db.collection("users").findOne({ username: user.username });
    assert.ok(stored.mfa.enabled);
    const raw = JSON.stringify(stored);
    assert.ok(!raw.includes(start.body.manualKey));
    assert.ok(!raw.includes(done.body.recoveryCodes[0]));
    assert.equal((await client.get(ME)).status, 200);
  });
});

describe("sessions (finding 4)", () => {
  function tokenFor(payload, key, options) {
    return jwt.sign(payload, key, { issuer: "cafems", audience: "cafems-staff", keyid: "k1", ...options });
  }

  async function asCookie(token) {
    const client = browser(app);
    client.jar[SESSION_COOKIE] = token;
    return (await client.get(ME)).status;
  }

  test("forged tokens are refused: alg none, wrong key, no server record", async () => {
    const user = await createUser(db, config, { role: "Admin" });
    const signedIn = await signIn(app, db, user);
    const { jti } = jwt.decode(signedIn.jar[SESSION_COOKIE]);
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.username, jti, iss: "cafems", aud: "cafems-staff" })).toString("base64url")}.`;
    assert.equal(await asCookie(none), 401);
    assert.equal(await asCookie(tokenFor({ jti }, "x".repeat(32), { subject: user.username })), 401);
    assert.equal(await asCookie(tokenFor({ jti: "no-such-session" }, config.jwt.keys.get("k1"), { subject: user.username })), 401);
    assert.equal(await asCookie(tokenFor({ jti }, config.jwt.keys.get("k1"), { subject: "someone.else" })), 401);
  });

  test("sign-out ends the session on the server, so a copied cookie stops working", async () => {
    const client = await signIn(app, db, await createUser(db, config));
    const stolen = client.jar[SESSION_COOKIE];
    assert.equal((await client.post("/api/v1/auth/logout", {})).status, 204);
    assert.equal(await asCookie(stolen), 401);
  });

  test("5 idle minutes end the session", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    await db.collection("sessions").updateOne({ username: user.username }, { $set: { lastSeenAt: new Date(Date.now() - 6 * 60 * 1000) } });
    assert.equal((await client.get(ME)).status, 401);
  });

  test("the 8-hour limit applies however active the session is", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    await db.collection("sessions").updateOne({ username: user.username }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await client.get(ME)).status, 401);
  });

  test("background refreshes do not keep an idle session alive", async () => {
    const request = require("supertest");
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    const old = new Date(Date.now() - 60 * 1000);
    await db.collection("sessions").updateOne({ username: user.username }, { $set: { lastSeenAt: old } });
    await request(app).get(ME).set("Cookie", `${SESSION_COOKIE}=${client.jar[SESSION_COOKIE]}`).set("X-Background-Refresh", "1");
    const stored = await db.collection("sessions").findOne({ username: user.username });
    assert.equal(stored.lastSeenAt.getTime(), old.getTime());
  });

  test("disabling a user or changing their role takes effect on the next request", async () => {
    const a = await createUser(db, config);
    const clientA = await signIn(app, db, a);
    await db.collection("users").updateOne({ username: a.username }, { $set: { status: "Disabled" } });
    assert.equal((await clientA.get(ME)).status, 401);

    const b = await createUser(db, config);
    const clientB = await signIn(app, db, b);
    await db.collection("users").updateOne({ username: b.username }, { $set: { role: "Manager" } });
    assert.equal((await clientB.get(ME)).status, 401);
  });

  test("the device list shows only your sessions, and you can revoke only your own", async () => {
    const a = await createUser(db, config);
    const b = await createUser(db, config);
    const clientA = await signIn(app, db, a);
    const otherDevice = await signIn(app, db, a);
    const clientB = await signIn(app, db, b);

    const list = (await clientA.get("/api/v1/auth/sessions")).body.sessions;
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes("csrf"));

    const other = list.find((s) => !s.current);
    assert.equal((await clientB.delete(`/api/v1/auth/sessions/${other.id}`)).status, 404);
    assert.equal((await otherDevice.get(ME)).status, 200);
    assert.equal((await clientA.delete(`/api/v1/auth/sessions/${other.id}`)).status, 204);
    assert.equal((await otherDevice.get(ME)).status, 401);
  });
});

describe("CSRF and origin (finding 13)", () => {
  test("a signed-in change needs the CSRF token", async () => {
    const client = await signIn(app, db, await createUser(db, config));
    assert.equal((await client.post("/api/v1/auth/logout", {}, { noCsrf: true })).body.error.code, "bad_csrf");
    assert.equal((await client.post("/api/v1/auth/logout", {}, { csrf: "wrong-token" })).body.error.code, "bad_csrf");
    assert.equal((await client.get(ME)).status, 200);
  });

  test("requests from another site, or with no Origin, are blocked", async () => {
    const user = await createUser(db, config);
    for (const origin of ["https://evil.example", null]) {
      const res = await browser(app).post(LOGIN, { username: user.username, password: user.password }, { origin });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "bad_origin");
    }
  });
});

describe("changing a password", () => {
  test("needs the current password, enforces the rules and ends other sessions", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    const other = await signIn(app, db, user);
    const PATH = "/api/v1/auth/password";
    assert.equal((await client.post(PATH, { currentPassword: "Wrong-Password-99!", newPassword: "New-Strong-Pass-42!" })).status, 401);
    assert.equal((await client.post(PATH, { currentPassword: user.password, newPassword: "short" })).body.error.code, "weak_password");
    assert.equal((await client.post(PATH, { currentPassword: user.password, newPassword: "New-Strong-Pass-42!" })).status, 204);
    assert.equal((await client.get(ME)).status, 200);
    assert.equal((await other.get(ME)).status, 401);
    assert.equal((await browser(app).post(LOGIN, { username: user.username, password: user.password })).status, 401);
  });
});

test("the auth rate limit stops rapid guessing across accounts", async () => {
  const limited = buildApp(db, { authPer15Minutes: 3 }).app;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await browser(limited).post(LOGIN, { username: `guess${i}`, password: "Wrong-Password-99!" })).status);
  assert.deepEqual(statuses, [401, 401, 401, 429]);
});
