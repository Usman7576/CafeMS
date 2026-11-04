// Adds any missing settings to .env, generating random keys. Existing values are never changed
// and keys are never printed.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const has = (name) => new RegExp(`^${name}=.+`, "m").test(existing);
const newKey = () => `k1:${crypto.randomBytes(32).toString("base64")}`;

const defaults = {
  NODE_ENV: "development",
  PORT: "3000",
  MONGODB_URI: "mongodb://127.0.0.1:27017",
  MONGODB_DB: "cafems",
  APP_ORIGIN: "http://localhost:3000",
  JWT_KEYS: newKey(),
  JWT_ACTIVE_KEY: "k1",
  DATA_KEYS: newKey(),
  DATA_ACTIVE_KEY: "k1"
};

const missing = Object.keys(defaults).filter((name) => !has(name));
if (!missing.length) {
  console.log(".env already has every setting. Nothing changed.");
} else {
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, prefix + missing.map((name) => `${name}=${defaults[name]}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Added to .env: ${missing.join(", ")}`);
}
