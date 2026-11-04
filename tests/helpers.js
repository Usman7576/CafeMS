const crypto = require("crypto");
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { authenticator } = require("otplib");
const { loadConfig } = require("../server/config");
const { createApp } = require("../server/app");
const { ensureIndexes } = require("../server/db");
const { createLogger } = require("../server/lib/logger");
const { hashPassword } = require("../server/lib/passwords");
const { encrypt } = require("../server/lib/crypto");

const ORIGIN = "http://localhost:3000";
const PASSWORD = "Correct-Horse-7-Battery";

function testEnv(extra = {}) {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    JWT_KEYS: `k1:${crypto.randomBytes(32).toString("base64")}`,
    JWT_ACTIVE_KEY: "k1",
    DATA_KEYS: `k1:${crypto.randomBytes(32).toString("base64")}`,
    DATA_ACTIVE_KEY: "k1",
    ...extra
  };
}

function testConfig(limits = {}) {
  const config = loadConfig(testEnv());
  return { ...config, limits: { ...config.limits, authPer15Minutes: 100000, apiPerMinute: 100000, ...limits } };
}

async function startDb() {
  const server = await MongoMemoryServer.create();
  const client = await MongoClient.connect(server.getUri());
  const db = client.db("cafems_test");
  await ensureIndexes(db);
  return { db, stop: async () => { await client.close(); await server.stop(); } };
}

function buildApp(db, limits) {
  const config = testConfig(limits);
  return { config, app: createApp({ config, db, logger: createLogger(config) }) };
}

// A small browser stand-in. It keeps cookies by hand because they are all marked Secure
// and tests run over plain HTTP. It always sends the correct Origin unless told otherwise.
function browser(app) {
  const jar = {};
  let csrf = null;

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
    if (method !== "get" && opts.origin !== null) req = req.set("Origin", opts.origin || ORIGIN);
    if (method !== "get" && csrf && !opts.noCsrf) req = req.set("X-CSRF-Token", opts.csrf || csrf);
    if (body !== undefined) req = req.send(body);
    return req.then(capture);
  }

  return {
    jar,
    get: (path, opts) => send("get", path, undefined, opts),
    post: (path, body, opts) => send("post", path, body, opts),
    delete: (path, opts) => send("delete", path, undefined, opts),
    loadCsrf: async () => {
      const res = await send("get", "/api/v1/auth/me");
      csrf = res.body.csrfToken;
      return res;
    }
  };
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
  return client;
}

module.exports = { ORIGIN, PASSWORD, testEnv, testConfig, startDb, buildApp, browser, createUser, freshCode, signIn };
