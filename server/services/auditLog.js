// Tamper-evident audit log. Each entry holds a SHA-256 link to the one before it and an Ed25519
// signature, so editing, removing or reordering an entry is detected. The actor comes from the verified
// session or the attempted login, never from a client-supplied field.
const crypto = require("crypto");
const { inTransaction } = require("../lib/tx");
const { ed25519Keys } = require("../lib/crypto");

const MAX_TEXT = 200;
const GENESIS = "GENESIS";
const signers = new WeakMap();

function clean(value) {
  // Removes control characters so a value cannot forge extra log lines
  return String(value === undefined || value === null ? "" : value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").slice(0, MAX_TEXT);
}

function bindAudit(db, config) {
  const keys = new Map([...config.audit.keys].map(([id, seed]) => [id, ed25519Keys(seed)]));
  signers.set(db, { activeId: config.audit.activeId, keys });
}

function entryHash(e) {
  const fields = [e.seq, e.at.toISOString(), e.actor, e.role, e.action, e.details, e.severity, e.ip, e.userAgent, e.requestId, e.prevHash];
  return crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

async function appendEntry(db, signer, fields, session) {
  const head = db.collection("audit_head");
  // Touching the head record puts all writers in one order; a clash makes the transaction retry
  const current = await head.findOneAndUpdate({ _id: "head" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after", session });
  const entry = { seq: current.seq, ...fields, prevHash: current.hash || GENESIS, kid: signer.activeId };
  entry.hash = entryHash(entry);
  entry.sig = crypto.sign(null, Buffer.from(entry.hash), signer.keys.get(signer.activeId).privateKey).toString("base64");
  await db.collection("audit_events").insertOne(entry, { session });
  await head.updateOne({ _id: "head" }, { $set: { hash: entry.hash } }, { session });
}

// Passing the caller's session puts the entry in the same transaction as the action it describes:
// if the entry cannot be written, the action does not happen.
async function recordEvent(db, req, event, options = {}) {
  const signer = signers.get(db);
  if (!signer) throw new Error("The audit log has no signing key.");
  const fields = {
    at: new Date(),
    actor: clean(event.actor || "system"),
    role: clean(event.role || ""),
    action: clean(event.action),
    details: clean(event.details),
    severity: ["info", "warning", "high"].includes(event.severity) ? event.severity : "info",
    ip: req ? clean(req.ip) : "",
    userAgent: req ? clean(req.get("user-agent")) : "",
    requestId: req ? clean(req.id) : ""
  };
  if (options.session) return appendEntry(db, signer, fields, options.session);
  return inTransaction(db, (session) => appendEntry(db, signer, fields, session));
}

// Checks every entry against its neighbours, its hash and its signature
async function verifyChain(db) {
  const signer = signers.get(db);
  if (!signer) throw new Error("The audit log has no signing key.");
  let expected = 1;
  let prev = GENESIS;
  const fail = (brokenAt, reason) => ({ ok: false, brokenAt, reason, count: expected - 1 });

  for await (const e of db.collection("audit_events").find({ seq: { $exists: true } }).sort({ seq: 1 })) {
    if (e.seq !== expected) return fail(expected, "An entry is missing.");
    if (e.prevHash !== prev) return fail(e.seq, "The link to the previous entry does not match.");
    if (entryHash(e) !== e.hash) return fail(e.seq, "The entry was changed.");
    const keys = signer.keys.get(e.kid);
    if (!keys || !crypto.verify(null, Buffer.from(e.hash), keys.publicKey, Buffer.from(e.sig, "base64"))) return fail(e.seq, "The signature is not valid.");
    prev = e.hash;
    expected += 1;
  }

  const head = await db.collection("audit_head").findOne({ _id: "head" });
  const lastSeq = expected - 1;
  if ((head ? head.seq : 0) !== lastSeq || (lastSeq > 0 && head.hash !== prev)) return fail(lastSeq + 1, "Entries are missing from the end of the log.");
  return { ok: true, count: lastSeq, lastHash: lastSeq ? prev : null };
}

function publicKeys(db) {
  const signer = signers.get(db);
  return [...signer.keys].map(([id, k]) => ({ id, active: id === signer.activeId, pem: k.publicKey.export({ type: "spki", format: "pem" }) }));
}

module.exports = { recordEvent, verifyChain, bindAudit, publicKeys, clean };
