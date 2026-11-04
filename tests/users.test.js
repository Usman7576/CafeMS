const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { authenticator } = require("otplib");
const { startDb, buildApp, browser, createUser, freshCode, signIn } = require("./helpers");
const { hashToken } = require("../server/lib/crypto");

let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const INVITE = "/api/v1/users/invitations";
const NEW_PASSWORD = "Brand-New-Pass-42!";

async function admin() {
  const user = await createUser(db, config, { role: "Admin" });
  const client = await signIn(app, db, user);
  return { user, client };
}
async function stepUp({ user, client }) {
  const res = await client.post("/api/v1/auth/step-up", { code: await freshCode(db, user) });
  assert.equal(res.status, 204);
}
const invitation = (username, role = "Waiter") => ({ username, name: "New Person", role });
const tokenOf = (url) => url.split("#token=")[1];

describe("invitations", () => {
  test("only an Admin can invite", async () => {
    for (const role of ["Waiter", "Kitchen", "Cashier", "Manager"]) {
      const user = await createUser(db, config, { role });
      const client = await signIn(app, db, user);
      assert.equal((await client.post(INVITE, invitation("not.allowed"))).status, 403);
      assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Access denied" }));
    }
    assert.equal((await browser(app).post(INVITE, invitation("not.allowed"))).status, 401);
  });

  test("an Admin must confirm a fresh authenticator code first", async () => {
    const a = await admin();
    const res = await a.client.post(INVITE, invitation("needs.stepup"));
    assert.equal(res.body.error.code, "step_up_required");
    await db.collection("sessions").updateOne({ username: a.user.username }, { $set: { stepUpAt: new Date(Date.now() - 6 * 60 * 1000) } });
    assert.equal((await a.client.post(INVITE, invitation("needs.stepup"))).body.error.code, "step_up_required");
  });

  test("one Admin alone cannot create another Admin", async () => {
    const a = await admin();
    await stepUp(a);
    const res = await a.client.post(INVITE, invitation("second.admin", "Admin"));
    assert.equal(res.status, 403);
    assert.equal(await db.collection("users").findOne({ username: "second.admin" }), null);
  });

  test("the whole flow: invite, set password, enrol, sign in", async () => {
    const a = await admin();
    await stepUp(a);
    const created = await a.client.post(INVITE, invitation("new.waiter"));
    assert.equal(created.status, 201);
    const token = tokenOf(created.body.setupUrl);

    const person = browser(app);
    assert.equal((await person.post("/api/v1/auth/setup", { token, password: "weak" })).body.error.code, "weak_password");
    assert.deepEqual((await person.post("/api/v1/auth/setup", { token, password: NEW_PASSWORD })).body, { next: "enroll" });
    const start = await person.post("/api/v1/auth/mfa/enroll/start", {});
    assert.equal((await person.post("/api/v1/auth/mfa/enroll/confirm", { code: authenticator.generate(start.body.manualKey) })).status, 200);
    assert.equal((await person.get("/api/v1/auth/me")).body.role, "Waiter");
  });

  test("a link works once, and only its hash is stored", async () => {
    const a = await admin();
    await stepUp(a);
    const token = tokenOf((await a.client.post(INVITE, invitation("single.use"))).body.setupUrl);
    assert.ok(await db.collection("auth_tokens").findOne({ _id: hashToken(token) }));
    assert.equal(await db.collection("auth_tokens").findOne({ _id: token }), null);
    assert.equal((await browser(app).post("/api/v1/auth/setup", { token, password: NEW_PASSWORD })).status, 200);
    assert.equal((await browser(app).post("/api/v1/auth/setup", { token, password: NEW_PASSWORD })).body.error.code, "bad_setup_link");
  });

  test("an expired link is refused", async () => {
    const a = await admin();
    await stepUp(a);
    const token = tokenOf((await a.client.post(INVITE, invitation("late.person"))).body.setupUrl);
    await db.collection("auth_tokens").updateOne({ _id: hashToken(token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await browser(app).post("/api/v1/auth/setup", { token, password: NEW_PASSWORD })).status, 400);
  });

  test("an invited person cannot sign in before finishing setup", async () => {
    const a = await admin();
    await stepUp(a);
    await a.client.post(INVITE, invitation("not.ready"));
    assert.equal((await browser(app).post("/api/v1/auth/login", { username: "not.ready", password: NEW_PASSWORD })).status, 401);
  });

  test("usernames and input are validated", async () => {
    const a = await admin();
    await stepUp(a);
    assert.equal((await a.client.post(INVITE, { username: "bad name!", name: "X Y", role: "Waiter" })).status, 400);
    assert.equal((await a.client.post(INVITE, { username: { $gt: "" }, name: "X Y", role: "Waiter" })).status, 400);
    assert.equal((await a.client.post(INVITE, { ...invitation("extra.field"), status: "Active" })).status, 400);
    assert.equal((await a.client.post(INVITE, invitation("wrong.role", "Owner"))).status, 400);
    await a.client.post(INVITE, invitation("taken.name"));
    assert.equal((await a.client.post(INVITE, invitation("taken.name"))).status, 409);
  });
});

describe("account reset and unlock", () => {
  test("a reset ends sessions and old credentials straight away", async () => {
    const a = await admin();
    await stepUp(a);
    const target = await createUser(db, config);
    const client = await signIn(app, db, target);
    const res = await a.client.post(`/api/v1/users/${target.username}/reset-link`, {});
    assert.equal(res.status, 201);
    assert.equal((await client.get("/api/v1/auth/me")).status, 401);
    assert.equal((await browser(app).post("/api/v1/auth/login", { username: target.username, password: target.password })).status, 401);
    assert.ok(await db.collection("audit_events").findOne({ actor: a.user.username, action: "Account reset" }));
  });

  test("an Admin cannot reset their own account this way", async () => {
    const a = await admin();
    await stepUp(a);
    assert.equal((await a.client.post(`/api/v1/users/${a.user.username}/reset-link`, {})).body.error.code, "own_account");
  });

  test("an Admin can unlock an account", async () => {
    const a = await admin();
    await stepUp(a);
    const target = await createUser(db, config);
    await db.collection("users").updateOne({ username: target.username }, { $set: { lockedUntil: new Date(Date.now() + 60000) } });
    assert.equal((await a.client.post(`/api/v1/users/${target.username}/unlock`, {})).status, 204);
    assert.equal((await browser(app).post("/api/v1/auth/login", { username: target.username, password: target.password })).status, 200);
  });
});
