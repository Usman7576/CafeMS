const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const authenticator = require("../server/lib/totp");
const { loadConfig } = require("../server/config");
const { createApp } = require("../server/app");
const { ensureIndexes, ensureAuditIndexes } = require("../server/db");
const { createLogger } = require("../server/lib/logger");
const { hashPassword } = require("../server/lib/passwords");
const { encrypt } = require("../server/lib/crypto");

const ORIGIN = "http://localhost:3000";
// One audit key per test file, as a real deployment has one, so entries from every app instance verify
const AUDIT_KEYS = `k1:${crypto.randomBytes(32).toString("base64")}`;
const PASSWORD = "Correct-Horse-7-Battery";

function testEnv(extra = {}) {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    JWT_KEYS: `k1:${crypto.randomBytes(32).toString("base64")}`,
    JWT_ACTIVE_KEY: "k1",
    DATA_KEYS: `k1:${crypto.randomBytes(32).toString("base64")}`,
    DATA_ACTIVE_KEY: "k1",
    BLIND_INDEX_KEY: crypto.randomBytes(32).toString("base64"),
    AUDIT_KEYS,
    AUDIT_ACTIVE_KEY: "k1",
    GATEWAY_SECRET: crypto.randomBytes(32).toString("base64"),
    UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "cafems-uploads-")),
    ...extra
  };
}

function testConfig(limits = {}) {
  const config = loadConfig(testEnv());
  return { ...config, limits: { ...config.limits, authPer15Minutes: 100000, apiPerMinute: 100000, userPerMinute: 100000, sitePerMinute: 100000, publicReadsPerMinute: 100000, ...limits } };
}

async function startDb() {
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await MongoClient.connect(server.getUri());
  const db = client.db("cafems_test");
  await ensureIndexes(db);
  await ensureAuditIndexes(db);
  return { db, uri: server.getUri(), stop: async () => { await client.close(); await server.stop(); } };
}

function buildApp(db, limits, gateway) {
  const config = testConfig(limits);
  return { config, app: createApp({ config, db, logger: createLogger(config), gateway }) };
}

// A small browser stand-in. It keeps cookies by hand because they are all marked Secure
// and tests run over plain HTTP. It always sends the correct Origin unless told otherwise.
// Signs a request as the browser does, with the person's device key
function signHeaders(key, method, path, body) {
  const signedAt = String(Date.now());
  const bodyHash = crypto.createHash("sha256").update(body === undefined ? "" : JSON.stringify(body)).digest("hex");
  const text = ["cafems-action-v1", method.toUpperCase(), path, signedAt, bodyHash].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(text), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return { "X-Signing-Key": key.id, "X-Signed-At": signedAt, "X-Action-Signature": signature };
}

// Gives a person a device key, as the browser does after sign-in
async function addSigningKey(db, username) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = crypto.randomBytes(16).toString("base64url");
  await db.collection("signing_keys").insertOne({ _id: id, username, label: "Test device", publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, createdAt: new Date(), revokedAt: null });
  return { id, privateKey };
}

function browser(app) {
  const jar = {};
  let csrf = null;
  const self = {};

  function capture(res) {
    for (const line of res.headers["set-cookie"] || []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value) jar[name] = value; else delete jar[name];
    }
    return res;
  }

  function send(method, path, body, opts = {}) {
    let req = request(app)[method](path);
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) req = req.set("Cookie", cookie);
    if (opts.headers) req = req.set(opts.headers);
    if (method !== "get" && opts.origin !== null) req = req.set("Origin", opts.origin || ORIGIN);
    if (method !== "get" && csrf && !opts.noCsrf) req = req.set("X-CSRF-Token", opts.csrf || csrf);
    // Sign-in requests are never signed, as in the browser
    if (method !== "get" && self.signingKey && !opts.unsigned && !path.startsWith("/api/v1/auth/")) req = req.set(signHeaders(self.signingKey, method, path, body));
    if (body !== undefined) req = req.send(body);
    return req.then(capture);
  }

  return Object.assign(self, {
    jar,
    get: (path, opts) => send("get", path, undefined, opts),
    post: (path, body, opts) => send("post", path, body, opts),
    put: (path, body, opts) => send("put", path, body, opts),
    delete: (path, opts) => send("delete", path, undefined, opts),
    loadCsrf: async () => {
      const res = await send("get", "/api/v1/auth/me");
      csrf = res.body.csrfToken;
      return res;
    }
  });
}

let counter = 0;
async function createUser(db, config, overrides = {}) {
  counter += 1;
  const username = overrides.username || `user${counter}.${crypto.randomBytes(3).toString("hex")}`;
  const secret = authenticator.generateSecret(20);
  const withMfa = overrides.mfa !== false;
  await db.collection("users").insertOne({
    username,
    name: overrides.name || "Test Person",
    role: overrides.role || "Waiter",
    status: overrides.status || "Active",
    passwordHash: await hashPassword(overrides.password || PASSWORD),
    failedAttempts: 0,
    lockedUntil: null,
    mfa: withMfa
      ? { enabled: true, secretEnc: encrypt(secret, `mfa-secret:${username}`, config.data), lastStep: 0, recoveryHashes: overrides.recoveryHashes || [] }
      : { enabled: false }
  });
  return { username, secret, password: overrides.password || PASSWORD };
}

// Time steps are single-use, so tests clear the marker to take another code in the same 30 seconds
async function freshCode(db, user) {
  await db.collection("users").updateOne({ username: user.username }, { $set: { "mfa.lastStep": 0 } });
  return authenticator.generate(user.secret);
}

async function signIn(app, db, user) {
  const client = browser(app);
  const login = await client.post("/api/v1/auth/login", { username: user.username, password: user.password });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const verify = await client.post("/api/v1/auth/mfa/verify", { code: await freshCode(db, user) });
  if (verify.status !== 200) throw new Error(`MFA failed: ${verify.status}`);
  await client.loadCsrf();
  client.signingKey = await addSigningKey(db, user.username);
  return client;
}

module.exports = { ORIGIN, PASSWORD, testEnv, testConfig, startDb, buildApp, browser, createUser, freshCode, signIn, addSigningKey, signHeaders };
