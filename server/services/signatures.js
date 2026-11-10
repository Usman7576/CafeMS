// Personal signatures for sensitive actions (non-repudiation). Each browser creates its own ECDSA P-256
// key pair; the private key cannot be exported from the browser, and only the public key is sent here,
// after a fresh authenticator check. Refunds, approvals, staff access changes and erasures must carry a
// signature from that person's key. The server checks it, keeps it, and can check it again later, so
// an action can be proved to come from that person's device rather than only from the server's record.
const crypto = require("crypto");
const { AppError } = require("../lib/errors");
const { randomToken } = require("../lib/crypto");
const { recordEvent } = require("./auditLog");

const FORMAT = "cafems-action-v1";
const FRESH_MS = 5 * 60 * 1000;
const MAX_KEYS_PER_PERSON = 5;
const KEY_ID = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const SIGNED_AT = /^\d{13}$/;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// The exact text that is signed: what was done, where, when, and a hash of the request body
function message({ method, path, signedAt, bodyHash }) {
  return [FORMAT, method, path, String(signedAt), bodyHash].join("\n");
}

function verifyWith(publicKey, text, signature) {
  try {
    const key = crypto.createPublicKey({ key: publicKey, format: "jwk" });
    return crypto.verify("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function createSignatureService({ config, db }) {
  const keys = db.collection("signing_keys");
  const signed = db.collection("signed_actions");
  const invalid = () => new AppError(403, "signature_invalid", "This device's signing key was not accepted. Try again to set up a new one.");

  // A key may be added only straight after signing in or after a fresh authenticator code
  async function register(req, { publicKey, label }) {
    const { user, session } = req.auth;
    const now = Date.now();
    const fresh = (session.stepUpAt && now - session.stepUpAt.getTime() <= config.auth.stepUpMs) || now - session.createdAt.getTime() <= config.auth.stepUpMs;
    if (!fresh) throw new AppError(403, "step_up_required", "Confirm your authenticator code to continue.");
    let details;
    try {
      details = crypto.createPublicKey({ key: publicKey, format: "jwk" }).asymmetricKeyDetails;
    } catch {
      details = null;
    }
    if (!details || details.namedCurve !== "prime256v1") throw new AppError(400, "invalid_input", "That is not a valid P-256 public key.");

    const id = randomToken(16);
    await keys.insertOne({ _id: id, username: user.username, label, publicKey, createdAt: new Date(now), revokedAt: null });
    // Older keys beyond the limit stop working, so lost devices do not pile up
    const active = await keys.find({ username: user.username, revokedAt: null }).sort({ createdAt: -1 }).skip(MAX_KEYS_PER_PERSON).toArray();
    if (active.length) await keys.updateMany({ _id: { $in: active.map((k) => k._id) } }, { $set: { revokedAt: new Date(now) } });
    await recordEvent(db, req, { actor: user.username, role: user.role, action: "Signing key registered", details: `${label} · key ${id.slice(0, 8)}`, severity: "warning" });
    return { id };
  }

  async function list(username) {
    const rows = await keys.find({ username, revokedAt: null }).sort({ createdAt: -1 }).toArray();
    return rows.map((k) => ({ id: k._id, label: k.label, createdAt: k.createdAt }));
  }

  async function revoke(req, id) {
    const { user } = req.auth;
    const result = await keys.updateOne({ _id: id, username: user.username, revokedAt: null }, { $set: { revokedAt: new Date() } });
    if (!result.matchedCount) throw new AppError(404, "not_found", "Key not found.");
    await recordEvent(db, req, { actor: user.username, role: user.role, action: "Signing key removed", details: `key ${id.slice(0, 8)}`, severity: "warning" });
  }

  // Checks the request's signature, refuses a reused one, and keeps it so it can be checked again
  async function verifyRequest(req) {
    const keyId = req.get("x-signing-key");
    const signedAt = req.get("x-signed-at");
    const signature = req.get("x-action-signature");
    if (!keyId || !signedAt || !signature) throw new AppError(403, "signature_required", "This action must be signed by your device.");
    if (!KEY_ID.test(keyId) || !SIGNED_AT.test(signedAt) || !SIGNATURE.test(signature)) throw invalid();
    if (Math.abs(Date.now() - Number(signedAt)) > FRESH_MS) throw invalid();

    const { user } = req.auth;
    const key = await keys.findOne({ _id: keyId, username: user.username, revokedAt: null });
    const parts = { method: req.method, path: req.originalUrl, signedAt: Number(signedAt), bodyHash: sha256(req.rawBody || "") };
    if (!key || !verifyWith(key.publicKey, message(parts), signature)) {
      await recordEvent(db, req, { actor: user.username, role: user.role, action: "Signature refused", details: `${req.method} ${req.originalUrl}`, severity: "high" });
      throw invalid();
    }
    try {
      await signed.insertOne({ _id: sha256(signature), username: user.username, keyId, ...parts, signature, at: new Date() });
    } catch (error) {
      if (error.code === 11000) throw new AppError(409, "signature_reused", "This signed request was already used.");
      throw error;
    }
    await recordEvent(db, req, { actor: user.username, role: user.role, action: "Action signed", details: `${req.method} ${req.originalUrl} · key ${keyId.slice(0, 8)}`, severity: "info" });
  }

  // Re-checks every kept signature against the key it claims, so a changed record is found
  async function verifyAll() {
    const publicKeys = new Map();
    let checked = 0;
    const failed = [];
    for await (const s of signed.find().sort({ at: 1 })) {
      checked += 1;
      if (!publicKeys.has(s.keyId)) {
        const key = await keys.findOne({ _id: s.keyId });
        publicKeys.set(s.keyId, key && key.username === s.username ? key.publicKey : null);
      }
      const publicKey = publicKeys.get(s.keyId);
      const ok = publicKey && sha256(s.signature) === s._id && verifyWith(publicKey, message(s), s.signature);
      if (!ok) failed.push(s._id.slice(0, 12));
    }
    return { checked, valid: checked - failed.length, failed };
  }

  return { register, list, revoke, verifyRequest, verifyAll };
}

module.exports = { createSignatureService, message, FORMAT };
