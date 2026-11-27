// Passkeys with a fingerprint, face or PIN (biometric access, Week 2 scenario 11) and the security
// question asked with a recovery code (Week 2 scenario 2).
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { isoCBOR } = require("@simplewebauthn/server/helpers");
const { startDb, buildApp, browser, createUser, signIn, freshCode, ORIGIN } = require("./helpers");
const { hashToken } = require("../server/lib/crypto");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const bytes = (buffer) => new Uint8Array(buffer);

// A software authenticator that builds exactly what a phone or laptop sends. "uv" is the flag the
// device sets after it has checked the fingerprint, face or PIN.
function softAuthenticator(origin = ORIGIN, rpID = new URL(ORIGIN).hostname) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = crypto.randomBytes(32);
  const rpIdHash = crypto.createHash("sha256").update(rpID).digest();
  let signCount = 0;
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, bytes(Buffer.from(jwk.x, "base64url"))], [-3, bytes(Buffer.from(jwk.y, "base64url"))]]);
  return {
    create(options, { uv = true } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x01 | (uv ? 0x04 : 0) | 0x40]), Buffer.alloc(4), Buffer.alloc(16), idLength, credentialId, Buffer.from(isoCBOR.encode(cose))]);
      const attestation = isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", bytes(authData)]]));
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: "public-key",
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation), transports: ["internal"] },
        clientExtensionResults: {}, authenticatorAttachment: "platform"
      };
    },
    get(options, { uv = true, at = origin } = {}) {
      signCount += 1;
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: at, crossOrigin: false }));
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x01 | (uv ? 0x04 : 0)]), counter]);
      const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), privateKey);
      return {
        id: b64u(credentialId), rawId: b64u(credentialId), type: "public-key",
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null },
        clientExtensionResults: {}, authenticatorAttachment: "platform"
      };
    }
  };
}

async function withPasskey(role = "Waiter") {
  const user = await createUser(db, config, { role });
  const client = await signIn(app, db, user);
  const device = softAuthenticator();
  const options = (await client.post(`${API}/auth/passkeys/register/options`, {})).body;
  const added = await client.post(`${API}/auth/passkeys`, { response: device.create(options), label: "Phone" });
  assert.equal(added.status, 201, added.text);
  return { user, client, device };
}

async function passwordStep(user) {
  const client = browser(app);
  assert.equal((await client.post(`${API}/auth/login`, { username: user.username, password: user.password })).status, 200);
  return client;
}

describe("passkeys (fingerprint, face or PIN)", () => {
  test("a passkey can be added straight after sign-in, and the change is recorded", async () => {
    const { user, client } = await withPasskey();
    const list = (await client.get(`${API}/auth/passkeys`)).body.passkeys;
    assert.equal(list.length, 1);
    assert.equal(list[0].label, "Phone");
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Passkey added" }));
  });

  test("adding a passkey later needs a fresh authenticator check", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    await db.collection("sessions").updateMany({ username: user.username }, { $set: { createdAt: new Date(Date.now() - 10 * 60 * 1000), stepUpAt: null } });
    const res = await client.post(`${API}/auth/passkeys/register/options`, {});
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "step_up_required");
  });

  test("a passkey without the device's fingerprint or PIN check is refused when added", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    const options = (await client.post(`${API}/auth/passkeys/register/options`, {})).body;
    const res = await client.post(`${API}/auth/passkeys`, { response: softAuthenticator().create(options, { uv: false }), label: "Phone" });
    assert.equal(res.status, 401);
  });

  test("password then passkey signs in", async () => {
    const { user, device } = await withPasskey();
    const client = await passwordStep(user);
    const options = (await client.post(`${API}/auth/mfa/passkey/options`, {})).body;
    const res = await client.post(`${API}/auth/mfa/passkey`, { response: device.get(options) });
    assert.equal(res.status, 200, res.text);
    assert.equal((await client.get(`${API}/auth/me`)).status, 200);
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Signed in", details: "Password and passkey" }));
  });

  test("a look-alike site, a skipped fingerprint or PIN check, a replay or someone else's passkey is refused", async () => {
    const { user, device } = await withPasskey();
    const other = await withPasskey();
    const attempt = async (make) => {
      const client = await passwordStep(user);
      const options = (await client.post(`${API}/auth/mfa/passkey/options`, {})).body;
      return client.post(`${API}/auth/mfa/passkey`, { response: make(options) });
    };
    assert.equal((await attempt((o) => device.get(o, { at: "https://cafems-login.example" }))).status, 401, "phishing site");
    assert.equal((await attempt((o) => device.get(o, { uv: false }))).status, 401, "no fingerprint or PIN");
    assert.equal((await attempt((o) => other.device.get(o))).status, 401, "another person's passkey");
    // Three refusals lock the account, as for wrong codes; an Admin would unlock it
    const locked = await db.collection("users").findOne({ username: user.username });
    assert.ok(locked.lockedUntil > new Date(), "failed passkeys count towards the lock");
    await db.collection("users").updateOne({ username: user.username }, { $set: { lockedUntil: null, failedAttempts: 0 } });

    const client = await passwordStep(user);
    const options = (await client.post(`${API}/auth/mfa/passkey/options`, {})).body;
    const response = device.get(options);
    assert.equal((await client.post(`${API}/auth/mfa/passkey`, { response })).status, 200);
    const again = await passwordStep(user);
    await again.post(`${API}/auth/mfa/passkey/options`, {});
    assert.equal((await again.post(`${API}/auth/mfa/passkey`, { response })).status, 401, "replayed answer");
  });

  test("a passkey without a password step is refused", async () => {
    const { device } = await withPasskey();
    const res = await browser(app).post(`${API}/auth/mfa/passkey`, { response: device.get({ challenge: "abc" }) });
    assert.equal(res.status, 401);
  });

  test("a passkey can confirm a sensitive action, and removing one needs that confirmation", async () => {
    const { client, device } = await withPasskey();
    await db.collection("sessions").updateMany({}, { $set: { stepUpAt: null } });
    const id = (await client.get(`${API}/auth/passkeys`)).body.passkeys[0].id;
    assert.equal((await client.delete(`${API}/auth/passkeys/${id}`)).status, 403);
    const options = (await client.post(`${API}/auth/step-up/passkey/options`, {})).body;
    assert.equal((await client.post(`${API}/auth/step-up/passkey`, { response: device.get(options) })).status, 204);
    assert.equal((await client.delete(`${API}/auth/passkeys/${id}`)).status, 204);
    assert.equal((await client.get(`${API}/auth/passkeys`)).body.passkeys.length, 0);
  });
});

describe("security question with a recovery code", () => {
  async function userWithQuestion(code) {
    const user = await createUser(db, config, { recoveryHashes: [hashToken(code)] });
    const client = await signIn(app, db, user);
    assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, user) })).status, 204);
    assert.equal((await client.post(`${API}/auth/security-question`, { question: "What was the name of your first school?", answer: "  City   Grammar " })).status, 204);
    return user;
  }

  test("setting a question needs a fresh code, and the answer is kept only as a hash", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    assert.equal((await client.post(`${API}/auth/security-question`, { question: "What was the name of your first school?", answer: "City" })).status, 403);
    const set = await userWithQuestion("QWERT-YUP23");
    const stored = await db.collection("users").findOne({ username: set.username });
    assert.match(stored.securityQuestion.answerHash, /^\$argon2id\$/);
    assert.ok(!JSON.stringify(stored).toLowerCase().includes("city grammar"));
  });

  test("a recovery code alone is not enough once a question is set", async () => {
    const code = "ASDFG-HJK23";
    const user = await userWithQuestion(code);
    const noAnswer = await passwordStep(user);
    assert.equal((await noAnswer.get(`${API}/auth/mfa/security-question`)).body.question, "What was the name of your first school?");
    assert.equal((await noAnswer.post(`${API}/auth/mfa/verify`, { recoveryCode: code })).status, 401);
    const wrong = await passwordStep(user);
    assert.equal((await wrong.post(`${API}/auth/mfa/verify`, { recoveryCode: code, answer: "Another School" })).status, 401);
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, details: "Wrong security answer" }));
    const right = await passwordStep(user);
    assert.equal((await right.post(`${API}/auth/mfa/verify`, { recoveryCode: code, answer: "city grammar" })).status, 200);
  });

  test("the question is shown only after the password step", async () => {
    assert.equal((await browser(app).get(`${API}/auth/mfa/security-question`)).status, 401);
  });
});
