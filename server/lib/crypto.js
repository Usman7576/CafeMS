// Published, standard primitives only (open design): security rests on the keys.
const crypto = require("crypto");
const net = require("net");

const IV_BYTES = 12;
// The full 16-byte GCM tag is required; a shortened tag would make forgeries far easier
const TAG_BYTES = 16;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// For high-entropy random tokens only. Passwords use Argon2id (see lib/passwords.js).
function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

// AES-256-GCM. `context` binds the ciphertext to its purpose, so a value copied
// to another field or user fails to decrypt.
function encrypt(plaintext, context, keyring) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyring.keys.get(keyring.activeId), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return ["v1", keyring.activeId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

function decrypt(value, context, keyring) {
  const [version, keyId, iv, tag, body] = String(value).split(".");
  const key = keyring.keys.get(keyId);
  if (version !== "v1" || !key) throw new Error("Unknown encrypted value format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

// A keyed hash for exact-match lookups of encrypted values, such as a phone number
function blindIndex(value, key) {
  return crypto.createHmac("sha256", key).update(String(value)).digest("hex");
}

// A keyed reference to the network an address belongs to (IPv4 /24, or the first three IPv6 groups).
// Comparing networks rather than exact addresses stops ordinary address changes raising alerts.
function networkRef(ip, key) {
  const text = String(ip || "").replace(/^::ffff:/i, "");
  const network = net.isIPv4(text) ? text.split(".").slice(0, 3).join(".") : text.split(":").slice(0, 3).join(":");
  return blindIndex(`network:${network}`, key);
}

// Builds an Ed25519 key pair from a 32-byte seed held in the settings
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function ed25519Keys(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

module.exports = { randomToken, hashToken, safeEqual, encrypt, decrypt, blindIndex, networkRef, ed25519Keys };
