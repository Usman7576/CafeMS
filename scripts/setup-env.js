// Adds any missing settings, generating random keys and passwords. Existing values are never changed,
// and nothing secret is printed.
//
//   npm run setup:env                                   development: .env and .mongo-keyfile
//   npm run setup:env -- --production --domain cafe.pk  production:  deploy/.env and deploy/.mongo-keyfile
//   npm run setup:env -- --production --domain localhost --https-port 8443   a local test of the stack
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const production = args.includes("--production");
const domain = option("--domain");
const httpsPort = option("--https-port") || "443";
const httpPort = option("--http-port") || "80";

if (production && !/^[a-z0-9.-]{1,253}$/i.test(domain || "")) {
  console.error("Give the site's domain, for example: npm run setup:env -- --production --domain cafe.example.com");
  process.exit(1);
}
if (!/^\d{1,5}$/.test(httpsPort) || !/^\d{1,5}$/.test(httpPort)) {
  console.error("Ports must be numbers.");
  process.exit(1);
}

const folder = production ? path.join(__dirname, "..", "deploy") : path.join(__dirname, "..");
const envPath = path.join(folder, ".env");

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
const appPassword = newPassword();

const keys = {
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
const database = {
  MONGODB_DB: "cafems",
  MONGODB_APP_USERNAME: "cafems_app",
  MONGODB_APP_PASSWORD: appPassword,
  // Used only by docker compose and npm run db:setup, never by the app
  MONGO_ROOT_USERNAME: "cafems_admin",
  MONGO_ROOT_PASSWORD: newPassword()
};

const defaults = production
  ? {
    // The compose file builds the app's database address from MONGODB_APP_USERNAME and its password
    DOMAIN: domain,
    APP_ORIGIN: `https://${domain}${httpsPort === "443" ? "" : `:${httpsPort}`}`,
    HTTPS_PORT: httpsPort,
    HTTP_PORT: httpPort,
    ...database,
    ...keys
  }
  : {
    NODE_ENV: "development",
    PORT: "3000",
    // The app signs in with its own least-privilege account (created by: npm run db:setup)
    MONGODB_URI: `mongodb://cafems_app:${appPassword}@127.0.0.1:27018/cafems?directConnection=true&authSource=cafems`,
    APP_ORIGIN: "http://localhost:3000",
    ...database,
    ...keys
  };

fs.mkdirSync(folder, { recursive: true });
const missing = Object.keys(defaults).filter((name) => !has(name));
const shown = path.relative(path.join(__dirname, ".."), envPath);
if (!missing.length) {
  console.log(`${shown} already has every setting. Nothing changed.`);
} else {
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envPath, prefix + missing.map((name) => `${name}=${defaults[name]}`).join("\n") + "\n", { mode: 0o600 });
  console.log(`Added to ${shown}: ${missing.join(", ")}`);
}

// The key file the database replica set needs once access control is on
const keyfilePath = path.join(folder, ".mongo-keyfile");
try {
  // The "wx" flag refuses to overwrite: an existing key file is left exactly as it is
  fs.writeFileSync(keyfilePath, crypto.randomBytes(512).toString("base64"), { mode: 0o600, flag: "wx" });
  console.log(`Created ${path.relative(path.join(__dirname, ".."), keyfilePath)} for the database.`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
