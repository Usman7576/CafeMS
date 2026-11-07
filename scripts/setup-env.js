// Adds any missing settings to .env, generating random keys. Existing values are never changed
// and keys are never printed.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const has = (name) => new RegExp(`^${name}=.+`, "m").test(existing);
const newKey = () => `k1:${crypto.randomBytes(32).toString("base64")}`;
// URL-safe, so a password can sit inside a connection string without escaping
const newPassword = () => crypto.randomBytes(24).toString("base64url");
const appPassword = newPassword();

const defaults = {
  NODE_ENV: "development",
  PORT: "3000",
  // The app signs in with its own least-privilege account (created by: npm run db:setup)
  MONGODB_URI: `mongodb://cafems_app:${appPassword}@127.0.0.1:27018/cafems?directConnection=true&authSource=cafems`,
  MONGODB_APP_USERNAME: "cafems_app",
  MONGODB_APP_PASSWORD: appPassword,
  // Used only by docker compose and npm run db:setup, never by the app
  MONGO_ROOT_USERNAME: "cafems_admin",
  MONGO_ROOT_PASSWORD: newPassword(),
  MONGODB_DB: "cafems",
  APP_ORIGIN: "http://localhost:3000",
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

// The key file the database replica set needs once access control is on
const keyfilePath = path.join(__dirname, "..", ".mongo-keyfile");
if (!fs.existsSync(keyfilePath)) {
  fs.writeFileSync(keyfilePath, crypto.randomBytes(512).toString("base64"), { mode: 0o600 });
  console.log("Created .mongo-keyfile for the database.");
}
