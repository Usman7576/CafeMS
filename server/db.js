const { MongoClient } = require("mongodb");

function createClient(config) {
  return new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000,
    maxPoolSize: 20
  });
}

const COLLECTIONS = ["users", "sessions", "auth_challenges", "auth_tokens", "audit_events", "menu", "inventory", "orders", "bills",
  "reservations", "tables", "counters", "settings", "approvals", "idempotency", "audit_head", "alerts", "outbox", "notifications", "system_status", "signing_keys", "signed_actions", "gateway_callbacks"];

// Transactions need a replica set. Refusing here is safer than failing halfway through a payment.
async function assertTransactionsAvailable(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error("MongoDB must run as a replica set. Run: docker compose up -d --wait");
}

async function ensureIndexes(db) {
  // Collections must exist before the first transaction uses them
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of COLLECTIONS) if (!existing.has(name)) await db.createCollection(name);

  await db.collection("users").createIndex({ username: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ jti: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ sid: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ username: 1 });
  await db.collection("sessions").createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_tokens").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_tokens").createIndex({ username: 1 });
  await db.collection("alerts").createIndex({ key: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "Open" } });
  await db.collection("alerts").createIndex({ status: 1, rule: 1, lastSeenAt: -1 });
  await db.collection("signing_keys").createIndex({ username: 1, revokedAt: 1, createdAt: -1 });
  await db.collection("outbox").createIndex({ status: 1, nextAttemptAt: 1 });
  await db.collection("outbox").createIndex({ sentAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
  await db.collection("notifications").createIndex({ deliveredAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
  await db.collection("bills").createIndex({ phoneIndex: 1 }, { sparse: true });
  await db.collection("orders").createIndex({ waiter: 1, createdAt: -1 });
  await db.collection("orders").createIndex({ table: 1, billed: 1 });
  await db.collection("orders").createIndex({ status: 1, updatedAt: 1 });
  await db.collection("bills").createIndex({ createdAt: -1 });
  await db.collection("reservations").createIndex({ date: 1, time: 1 });
  await db.collection("reservations").createIndex({ phoneIndex: 1, date: 1, time: 1 }, { unique: true, partialFilterExpression: { active: true } });
  await db.collection("approvals").createIndex({ status: 1, createdAt: -1 });
  await db.collection("idempotency").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("gateway_callbacks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

// Audit indexes are created by the administrator (npm run db:setup), because the app's own account must
// not be able to add indexes to the audit log: a time-to-live index would delete its entries.
async function ensureAuditIndexes(db) {
  await db.collection("audit_events").createIndex({ at: -1 });
  await db.collection("audit_events").createIndex({ seq: 1 }, { unique: true, sparse: true });
  await db.collection("audit_events").createIndex({ action: 1, at: -1 });
}

// Refuses to start rather than run without the index that keeps audit sequence numbers unique
async function assertAuditIndexes(db) {
  const indexes = await db.collection("audit_events").indexes();
  if (!indexes.some((i) => i.key.seq === 1 && i.unique)) throw new Error("The audit log has no indexes. Run: npm run db:setup");
}

module.exports = { createClient, ensureIndexes, ensureAuditIndexes, assertAuditIndexes, assertTransactionsAvailable };
