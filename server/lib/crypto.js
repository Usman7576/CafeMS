// Published, standard primitives only (open design): security rests on the keys.
const crypto = require("crypto");

const IV_BYTES = 12;

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
  const cipher = crypto.createCipheriv("aes-256-gcm", keyring.keys.get(keyring.activeId), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return ["v1", keyring.activeId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

function decrypt(value, context, keyring) {
  const [version, keyId, iv, tag, body] = String(value).split(".");
  const key = keyring.keys.get(keyId);
  if (version !== "v1" || !key) throw new Error("Unknown encrypted value format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

module.exports = { randomToken, hashToken, safeEqual, encrypt, decrypt };
