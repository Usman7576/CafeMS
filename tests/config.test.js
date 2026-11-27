const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { loadConfig, ConfigError } = require("../server/config");
const { testEnv } = require("./helpers");

const refuses = (env, pattern) => assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && pattern.test(e.message));

test("accepts valid settings and freezes them", () => {
  const config = loadConfig(testEnv());
  assert.equal(config.appOrigin, "http://localhost:3000");
  assert.ok(Object.isFrozen(config));
});

test("refuses to start without secrets", () => {
  refuses(testEnv({ JWT_KEYS: "" }), /JWT_KEYS/);
  refuses(testEnv({ DATA_KEYS: undefined }), /DATA_KEYS/);
});

test("refuses weak or wrongly sized keys", () => {
  refuses(testEnv({ JWT_KEYS: `k1:${Buffer.alloc(32, 1).toString("base64")}` }), /weak/);
  refuses(testEnv({ DATA_KEYS: `k1:${crypto.randomBytes(16).toString("base64")}` }), /32 random bytes/);
});

test("refuses an active key ID with no matching key", () => {
  refuses(testEnv({ JWT_ACTIVE_KEY: "k9" }), /active key/);
});

test("refuses the same key for tokens and data", () => {
  const shared = `k1:${crypto.randomBytes(32).toString("base64")}`;
  refuses(testEnv({ JWT_KEYS: shared, DATA_KEYS: shared }), /separate key/);
});

test("uploads cannot be stored inside the web root", () => {
  refuses(testEnv({ UPLOAD_DIR: "public/uploads" }), /outside the public folder/);
  refuses(testEnv({ UPLOAD_DIR: "public" }), /outside the public folder/);
});

test("the backup key is not needed by the server", () => {
  assert.equal(loadConfig({ ...testEnv(), BACKUP_KEY: undefined }).backupKey, undefined);
});

const PRODUCTION_DB = "mongodb://cafems_app:Long-Random-Password-1@mongo:27017/?replicaSet=rs0";

test("production requires https", () => {
  refuses(testEnv({ NODE_ENV: "production", APP_ORIGIN: "http://cafe.example", MONGODB_URI: PRODUCTION_DB }), /https/);
  assert.equal(loadConfig(testEnv({ NODE_ENV: "production", APP_ORIGIN: "https://cafe.example", MONGODB_URI: PRODUCTION_DB })).usesTls, true);
});

test("production refuses a database connection with no username and password (least privilege)", () => {
  refuses(testEnv({ NODE_ENV: "production", APP_ORIGIN: "https://cafe.example", MONGODB_URI: "mongodb://mongo:27017/?replicaSet=rs0" }), /username and password/);
});

test("error messages never contain secret values", () => {
  // Made at run time, so no secret-looking value is stored in the repository
  const secret = Buffer.from("secret-value-that-must-not-leak").toString("base64");
  assert.throws(() => loadConfig(testEnv({ JWT_KEYS: `k1:${secret}` })), (e) => !e.message.includes(secret));
});
