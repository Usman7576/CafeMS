// Sign-in with an organisation account through OpenID Connect (Week 2, slide 29), against a small but
// real OpenID provider running on this machine: discovery, signing keys, a token endpoint that checks
// PKCE, and signed ID tokens.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { startDb, browser, createUser, signIn, freshCode, testConfig } = require("./helpers");
const { createApp } = require("../server/app");
const { createLogger } = require("../server/lib/logger");

const API = "/api/v1";
const CLIENT_ID = "cafems-test";
const CLIENT_SECRET = crypto.randomBytes(16).toString("hex");
let ctx, db, app, config, providerServer, issuer;
const codes = new Map();
const tamper = { nonce: false, signature: false };
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64u = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function idToken(claims) {
  const head = b64u({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = b64u(claims);
  const signature = crypto.sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  return `${head}.${body}.${tamper.signature ? signature.replace(/^./, (c) => (c === "A" ? "B" : "A")) : signature}`;
}

function startProvider() {
  const p = express();
  p.use(express.urlencoded({ extended: false }));
  p.get("/.well-known/openid-configuration", (_req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]
  }));
  p.get("/jwks", (_req, res) => res.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] }));
  p.post("/token", (req, res) => {
    const basic = (req.get("authorization") || "").startsWith("Basic ") ? Buffer.from(req.get("authorization").slice(6), "base64").toString().split(":").map(decodeURIComponent) : null;
    const [id, secret] = basic || [req.body.client_id, req.body.client_secret];
    const grant = codes.get(req.body.code);
    codes.delete(req.body.code);
    const verifier = req.body.code_verifier || "";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET || !grant || grant.challenge !== challenge) return res.status(400).json({ error: "invalid_grant" });
    const now = Math.floor(Date.now() / 1000);
    return res.json({
      access_token: crypto.randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300,
      id_token: idToken({ iss: issuer, sub: grant.sub, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: tamper.nonce ? "wrong" : grant.nonce })
    });
  });
  return new Promise((resolve) => {
    providerServer = http.createServer(p).listen(0, "127.0.0.1", () => {
      issuer = `http://127.0.0.1:${providerServer.address().port}`;
      resolve();
    });
  });
}

// What the provider's sign-in page would do: the person signs in there, and it sends them back with a code
function signInAtProvider(authorizationUrl, sub) {
  const url = new URL(authorizationUrl);
  const code = crypto.randomBytes(12).toString("hex");
  codes.set(code, { sub, nonce: url.searchParams.get("nonce"), challenge: url.searchParams.get("code_challenge") });
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  return `${API}/auth/oidc/callback?code=${code}&state=${url.searchParams.get("state")}`;
}

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await startProvider();
  config = { ...testConfig(), oidc: { issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowHttp: true } };
  app = createApp({ config, db, logger: createLogger(config) });
});
after(async () => {
  providerServer.close();
  await ctx.stop();
});

async function linkedUser(sub) {
  const user = await createUser(db, config, { role: "Waiter" });
  const client = await signIn(app, db, user);
  assert.equal((await client.post(`${API}/auth/oidc/link`, {})).status, 403, "linking needs a fresh code");
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, user) })).status, 204);
  const started = await client.post(`${API}/auth/oidc/link`, {});
  assert.equal(started.status, 200);
  const back = await client.get(signInAtProvider(started.body.url, sub));
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, "/account.html#oidc-linked");
  return user;
}

async function startSignIn() {
  const client = browser(app);
  const res = await client.get(`${API}/auth/oidc/start`);
  assert.equal(res.status, 302);
  assert.ok(res.headers.location.startsWith(`${issuer}/authorize?`));
  return { client, url: res.headers.location };
}

describe("sign-in with an organisation account", () => {
  test("a linked organisation account replaces the password, and the cafe's own code is still required", async () => {
    const user = await linkedUser("alice-1");
    const { client, url } = await startSignIn();
    const back = await client.get(signInAtProvider(url, "alice-1"));
    assert.equal(back.headers.location, "/login.html#mfa");
    assert.equal((await client.get(`${API}/auth/me`)).status, 401, "not signed in before the second step");
    assert.equal((await client.post(`${API}/auth/mfa/verify`, { code: await freshCode(db, user) })).status, 200);
    assert.equal((await client.get(`${API}/auth/me`)).body.username, user.username);
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Organisation account accepted" }));
  });

  test("an organisation account nobody has linked gets nowhere", async () => {
    const { client, url } = await startSignIn();
    const back = await client.get(signInAtProvider(url, "stranger-9"));
    assert.equal(back.headers.location, "/login.html#oidc-failed");
    assert.equal((await client.post(`${API}/auth/mfa/verify`, { code: "123456" })).status, 401);
  });

  test("a callback from another browser, a replayed callback, a wrong nonce or a forged token is refused", async () => {
    await linkedUser("bob-2");

    const first = await startSignIn();
    const otherBrowser = browser(app);
    assert.equal((await otherBrowser.get(signInAtProvider(first.url, "bob-2"))).headers.location, "/login.html#oidc-failed", "login CSRF");

    const second = await startSignIn();
    const callback = signInAtProvider(second.url, "bob-2");
    assert.equal((await second.client.get(callback)).headers.location, "/login.html#mfa");
    const replay = browser(app);
    replay.jar["__Host-cms_oidc"] = new URL(callback, "http://x").searchParams.get("state");
    assert.equal((await replay.get(callback)).headers.location, "/login.html#oidc-failed", "replayed state");

    tamper.nonce = true;
    const third = await startSignIn();
    assert.equal((await third.client.get(signInAtProvider(third.url, "bob-2"))).headers.location, "/login.html#oidc-failed", "wrong nonce");
    tamper.nonce = false;

    tamper.signature = true;
    const fourth = await startSignIn();
    assert.equal((await fourth.client.get(signInAtProvider(fourth.url, "bob-2"))).headers.location, "/login.html#oidc-failed", "forged signature");
    tamper.signature = false;
  });

  test("one organisation account cannot be linked to two people, and unlinking needs a fresh code", async () => {
    await linkedUser("carol-3");
    const second = await createUser(db, config, { role: "Waiter" });
    const client = await signIn(app, db, second);
    assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, second) })).status, 204);
    const started = await client.post(`${API}/auth/oidc/link`, {});
    assert.equal((await client.get(signInAtProvider(started.body.url, "carol-3"))).headers.location, "/login.html#oidc-failed");
    assert.equal((await db.collection("users").findOne({ username: second.username })).oidc, undefined);

    await db.collection("sessions").updateMany({ username: second.username }, { $set: { stepUpAt: null } });
    assert.equal((await client.post(`${API}/auth/oidc/unlink`, {})).status, 403);
  });

  test("it is off unless configured, and settings without https are refused outside tests", async () => {
    const plain = createApp({ config: testConfig(), db, logger: createLogger(testConfig()) });
    assert.equal((await browser(plain).get(`${API}/auth/oidc/enabled`)).body.enabled, false);
    assert.equal((await browser(plain).get(`${API}/auth/oidc/start`)).status, 404);
    const { loadConfig } = require("../server/config");
    const { testEnv } = require("./helpers");
    assert.throws(() => loadConfig({ ...testEnv({}), NODE_ENV: "development", OIDC_ISSUER: "http://id.example", OIDC_CLIENT_ID: "a", OIDC_CLIENT_SECRET: "b" }), /https/);
  });
});
