// Personal signatures on sensitive actions (non-repudiation, Week 2 slide 15)
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { startDb, buildApp, createUser, signIn, freshCode, signHeaders, addSigningKey, ORIGIN } = require("./helpers");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

async function admin() {
  const user = await createUser(db, config, { role: "Admin" });
  const client = await signIn(app, db, user);
  client.user = user;
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, user) })).status, 204);
  return client;
}
const roleOf = async (username) => (await db.collection("users").findOne({ username })).role;
const events = (action) => db.collection("audit_events").countDocuments({ action });

// Sends a request with exactly the headers given, as an attacker replaying a capture would
function raw(client, path, body, headers) {
  const cookie = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return client.loadCsrf().then((me) => request(app).post(path).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", me.body.csrfToken).set(headers).send(body));
}

describe("signed sensitive actions", () => {
  test("an unsigned staff change is refused and nothing changes", async () => {
    const a = await admin();
    const staff = await createUser(db, config, { role: "Waiter" });
    const res = await a.post(`${API}/users/${staff.username}/role`, { role: "Cashier" }, { unsigned: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "signature_required");
    assert.equal(await roleOf(staff.username), "Waiter");
  });

  test("a signed change goes through, and the signature is kept and recorded", async () => {
    const a = await admin();
    const staff = await createUser(db, config, { role: "Waiter" });
    const before = await events("Action signed");
    assert.equal((await a.post(`${API}/users/${staff.username}/role`, { role: "Cashier" })).status, 200);
    assert.equal(await roleOf(staff.username), "Cashier");
    assert.equal(await events("Action signed"), before + 1);
    const kept = await db.collection("signed_actions").findOne({ username: a.user.username, path: `${API}/users/${staff.username}/role` });
    assert.equal(kept.keyId, a.signingKey.id);
  });

  test("a captured signed request cannot be replayed", async () => {
    const a = await admin();
    const staff = await createUser(db, config, { role: "Waiter" });
    const path = `${API}/users/${staff.username}/role`;
    const body = { role: "Cashier" };
    const headers = await signHeaders(a.signingKey, "post", path, body);
    assert.equal((await raw(a, path, body, headers)).status, 200);
    const again = await raw(a, path, { role: "Kitchen" }, headers);
    assert.equal(again.status, 403, "a signature does not cover a different body");
    const replay = await raw(a, path, body, headers);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, "signature_reused");
  });

  test("a signature over a changed body, another person's key, a removed key or an old time is refused", async () => {
    const a = await admin();
    const staff = await createUser(db, config, { role: "Waiter" });
    const path = `${API}/users/${staff.username}/role`;
    const refusedBefore = await events("Signature refused");

    const changed = await raw(a, path, { role: "Manager" }, await signHeaders(a.signingKey, "post", path, { role: "Kitchen" }));
    assert.equal(changed.body.error.code, "signature_invalid");

    const other = await addSigningKey(db, "someone.else");
    assert.equal((await raw(a, path, { role: "Kitchen" }, await signHeaders(other, "post", path, { role: "Kitchen" }))).body.error.code, "signature_invalid");

    const old = await addSigningKey(db, a.user.username);
    await db.collection("signing_keys").updateOne({ _id: old.id }, { $set: { revokedAt: new Date() } });
    assert.equal((await raw(a, path, { role: "Kitchen" }, await signHeaders(old, "post", path, { role: "Kitchen" }))).body.error.code, "signature_invalid");

    const stale = await signHeaders(a.signingKey, "post", path, { role: "Kitchen" });
    stale["X-Signed-At"] = String(Date.now() - 10 * 60 * 1000);
    assert.equal((await raw(a, path, { role: "Kitchen" }, stale)).body.error.code, "signature_invalid");

    assert.equal(await roleOf(staff.username), "Waiter");
    assert.ok(await events("Signature refused") >= refusedBefore + 3);
  });

  test("refunds and approvals need a signature too", async () => {
    const manager = await signIn(app, db, await createUser(db, config, { role: "Manager" }));
    manager.signingKey = undefined;
    const r1 = await manager.post(`${API}/bills/B-1/refund`, { reason: "Test refund" }, { headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
    const r2 = await manager.post(`${API}/approvals/aaaaaaaaaaaaaaaaaaaaaaaa/approve`, {});
    for (const r of [r1, r2]) assert.ok(r.status === 403 && ["step_up_required", "signature_required"].includes(r.body.error.code));
  });
});

describe("registering a device key", () => {
  const jwkOf = (curve) => {
    const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: curve });
    const jwk = publicKey.export({ format: "jwk" });
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  };

  test("a key can be added straight after sign-in, but later only after a fresh code", async () => {
    const user = await createUser(db, config, { role: "Waiter" });
    const client = await signIn(app, db, user);
    assert.equal((await client.post(`${API}/auth/signing-keys`, { publicKey: jwkOf("prime256v1"), label: "Laptop" })).status, 201);
    await db.collection("sessions").updateMany({ username: user.username }, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000), stepUpAt: null } });
    const later = await client.post(`${API}/auth/signing-keys`, { publicKey: jwkOf("prime256v1"), label: "Laptop" });
    assert.equal(later.status, 403);
    assert.equal(later.body.error.code, "step_up_required");
  });

  test("only P-256 public keys are accepted, and private parts or markup are refused", async () => {
    const client = await signIn(app, db, await createUser(db, config, { role: "Waiter" }));
    const bad = jwkOf("prime256v1");
    assert.equal((await client.post(`${API}/auth/signing-keys`, { publicKey: { ...bad, d: "secret" }, label: "x" })).status, 400);
    assert.equal((await client.post(`${API}/auth/signing-keys`, { publicKey: { ...bad, x: bad.y.replace(/^./, "A") }, label: "x" })).status, 400);
    assert.equal((await client.post(`${API}/auth/signing-keys`, { publicKey: bad, label: "<b>x</b>" })).status, 400);
  });
});

describe("checking kept signatures later", () => {
  test("every kept signature verifies, and a changed record is found", async () => {
    const a = await admin();
    const staff = await createUser(db, config, { role: "Waiter" });
    assert.equal((await a.post(`${API}/users/${staff.username}/role`, { role: "Kitchen" })).status, 200);
    const good = (await a.get(`${API}/audit/signatures/verify`)).body;
    assert.ok(good.checked >= 1);
    assert.deepEqual(good.failed, []);

    await db.collection("signed_actions").updateOne({ username: a.user.username }, { $set: { path: `${API}/users/${staff.username}/status` } });
    const bad = (await a.get(`${API}/audit/signatures/verify`)).body;
    assert.equal(bad.failed.length, 1);
  });
});
