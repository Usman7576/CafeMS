// Adds any missing settings to .env, generating random keys and passwords. Existing values are never
// changed, and nothing secret is printed.
//
//   npm run setup:env
//
// The database is the local MongoDB server (a single-node replica set on 127.0.0.1:27017; see
// docs/LOCAL-SETUP.md). The app signs in with its own least-privilege login, created by npm run db:setup.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");

// Reads the file directly and treats "not there" as empty, so nothing can change between a check and the read
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
const existing = readIfPresent(envPath);
// name is always one of the fixed setting names below
const has = (name) => new RegExp(`^${name}=.+`, "m").test(existing);
const newKey = () => `k1:${crypto.randomBytes(32).toString("base64")}`;
// URL-safe, so a password can sit inside a connection string without escaping
const newPassword = () => crypto.randomBytes(24).toString("base64url");
// An existing app password is kept, so the address below always matches the login in the database
const appPassword = (existing.match(/^MONGODB_APP_PASSWORD=(.+)$/m) || [])[1] || newPassword();

const defaults = {
  NODE_ENV: "development",
  PORT: "3000",
  APP_ORIGIN: "http://localhost:3000",
  // The app's own least-privilege login (created by: npm run db:setup)
  MONGODB_URI: `mongodb://cafems_app:${appPassword}@127.0.0.1:27017/cafems?replicaSet=rs0&authSource=cafems`,
  // Where npm run setup and npm run db:setup find the server, with the administrator login below
  MONGODB_HOST: "127.0.0.1:27017",
  MONGODB_DB: "cafems",
  MONGODB_APP_USERNAME: "cafems_app",
  MONGODB_APP_PASSWORD: appPassword,
  // Used only by npm run setup and npm run db:setup, never by the running app
  MONGO_ROOT_USERNAME: "cafems_admin",
  MONGO_ROOT_PASSWORD: newPassword(),
  JWT_KEYS: newKey(),
  JWT_ACTIVE_KEY: "k1",
  DATA_KEYS: newKey(),
  DATA_ACTIVE_KEY: "k1",
  BLIND_INDEX_KEY: crypto.randomBytes(32).toString("base64"),
  AUDIT_KEYS: newKey(),
  AUDIT_ACTIVE_KEY: "k1",
  GATEWAY_SECRET: crypto.randomBytes(32).toString("base64"),
  BACKUP_KEY: crypto.randomBytes(32).toString("base64")
};

const missing = Object.keys(defaults).filter((name) => !has(name));
if (!missing.length) {
  console.log(".env already has every setting. Nothing changed.");
} else {
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, prefix + missing.map((name) => `${name}=${defaults[name]}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Added to .env: ${missing.join(", ")}`);
}
