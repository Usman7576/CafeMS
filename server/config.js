// Validates all settings at startup. The server refuses to run with a missing or
// weak secret (fail-secure default), and error messages name the setting but never its value.
const path = require("path");
const { z } = require("zod");

const KEY_ID = /^[a-z0-9-]{1,16}$/;
const KEY_BYTES = 32;
const MIN_DISTINCT_BYTES = 16;

class ConfigError extends Error {}

// Parses "k1:<base64>,k2:<base64>". Several keys allow rotation: new data uses the
// active key while older keys stay available for reading.
function parseKeyring(raw, activeId, name) {
  const keys = new Map();
  for (const entry of String(raw || "").split(",").filter(Boolean)) {
    const split = entry.indexOf(":");
    const id = entry.slice(0, split);
    const material = Buffer.from(entry.slice(split + 1), "base64");
    if (split < 1 || !KEY_ID.test(id)) throw new ConfigError(`${name} has an invalid key ID.`);
    if (material.length !== KEY_BYTES) throw new ConfigError(`${name} keys must be exactly ${KEY_BYTES} random bytes in base64.`);
    if (new Set(material).size < MIN_DISTINCT_BYTES) throw new ConfigError(`${name} contains a weak key. Run: npm run setup:env`);
    keys.set(id, material);
  }
  if (!keys.size) throw new ConfigError(`${name} is required. Run: npm run setup:env`);
  if (!keys.has(activeId)) throw new ConfigError(`The active key ID for ${name} does not match any key.`);
  return { keys, activeId };
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017"),
  MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/).default("cafems"),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  UPLOAD_DIR: z.string().min(1).default("uploads")
});

function loadConfig(env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new ConfigError(`Invalid settings: ${names}`);
  }
  const s = parsed.data;
  const origin = new URL(s.APP_ORIGIN);
  if (origin.origin !== s.APP_ORIGIN) throw new ConfigError("APP_ORIGIN must be an origin only, with no path or trailing slash.");
  const isProduction = s.NODE_ENV === "production";
  if (isProduction && origin.protocol !== "https:") throw new ConfigError("APP_ORIGIN must use https in production.");
  // In production the app signs in to MongoDB with its own least-privilege account (server/lib/dbRoles.js)
  if (isProduction && !/^mongodb(?:\+srv)?:\/\/[^@/\s]+:[^@/\s]+@/.test(s.MONGODB_URI)) {
    throw new ConfigError("MONGODB_URI must include the app's database username and password in production.");
  }

  const jwt = parseKeyring(env.JWT_KEYS, env.JWT_ACTIVE_KEY, "JWT_KEYS");
  const data = parseKeyring(env.DATA_KEYS, env.DATA_ACTIVE_KEY, "DATA_KEYS");
  const blindIndexKey = parseKeyring(`index:${env.BLIND_INDEX_KEY || ""}`, "index", "BLIND_INDEX_KEY").keys.get("index");
  const audit = parseKeyring(env.AUDIT_KEYS, env.AUDIT_ACTIVE_KEY, "AUDIT_KEYS");
  const gatewaySecret = parseKeyring(`gateway:${env.GATEWAY_SECRET || ""}`, "gateway", "GATEWAY_SECRET").keys.get("gateway");
  const allKeys = [...jwt.keys.values(), ...data.keys.values(), ...audit.keys.values(), blindIndexKey, gatewaySecret];
  if (new Set(allKeys.map((k) => k.toString("base64"))).size !== allKeys.length) throw new ConfigError("Every secret must be a separate key.");

  // Uploaded files must never be reachable through the web root
  const uploadDir = path.resolve(s.UPLOAD_DIR);
  const publicDir = path.resolve(__dirname, "..", "public");
  if (uploadDir === publicDir || uploadDir.startsWith(publicDir + path.sep)) throw new ConfigError("UPLOAD_DIR must be outside the public folder.");

  return Object.freeze({
    env: s.NODE_ENV,
    isProduction,
    port: s.PORT,
    mongoUri: s.MONGODB_URI,
    mongoDb: s.MONGODB_DB,
    appOrigin: s.APP_ORIGIN,
    usesTls: origin.protocol === "https:",
    trustProxy: s.TRUST_PROXY,
    jwt,
    data,
    blindIndexKey,
    audit,
    gateway: Object.freeze({ secret: gatewaySecret, timeoutMs: 3000 }),
    uploadDir,
    retentionDays: 90,
    refundApprovalLimit: 5000,
    limits: Object.freeze({
      jsonBody: "100kb",
      photoBody: "2mb",
      // Per network address. A cafe's staff often share one Wi-Fi address, so this is set well above
      // what one person needs, and userPerMinute limits each signed-in person separately.
      apiPerMinute: 1200,
      userPerMinute: 240,
      // Pages, assets and health checks, which are outside the API
      sitePerMinute: 600,
      authPer15Minutes: 20,
      publicBookingsPerHour: 10
    }),
    auth: Object.freeze({
      maxFailedAttempts: 3,
      lockMs: 15 * 60 * 1000,
      sessionIdleMs: 5 * 60 * 1000,
      sessionAbsoluteMs: 8 * 60 * 60 * 1000,
      challengeMs: 5 * 60 * 1000,
      challengeMaxAttempts: 3,
      stepUpMs: 5 * 60 * 1000,
      setupTokenMs: 24 * 60 * 60 * 1000,
      recoveryCodes: 10
    })
  });
}

module.exports = { loadConfig, ConfigError };
