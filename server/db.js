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
  "reservations", "tables", "counters", "settings", "approvals", "idempotency", "audit_head", "alerts", "outbox", "notifications", "system_status",  "passkeys", "passkey_challenges", "gateway_callbacks", "staff_requests", "request_history", "checks", "shifts", "suppliers", "purchase_orders", "stock_counts", "waste_log", "customers", "loyalty_ledger", "vouchers", "waitlist", "feedback", "timeclock", "rota", "leave"];

// Transactions need a replica set. Refusing here is safer than failing halfway through a payment.
async function assertTransactionsAvailable(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error("MongoDB must run as a replica set (rs0). See docs/LOCAL-SETUP.md, then run: npm run setup");
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
  await db.collection("passkeys").createIndex({ username: 1, createdAt: 1 });
  await db.collection("passkey_challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
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
  // Staff requests: one title per owner, compared after trimming, collapsing spaces and ignoring case.
  // The database enforces it, so two requests sent at the same moment still produce one record.
  await db.collection("staff_requests").createIndex({ owner: 1, titleKey: 1 }, { unique: true, name: "one_title_per_owner" });
  // At most one open check per table or counter order, and one open shift per person
  await db.collection("checks").createIndex({ ref: 1 }, { unique: true, partialFilterExpression: { status: "Open" }, name: "one_open_check" });
  await db.collection("checks").createIndex({ createdAt: -1 });
  await db.collection("shifts").createIndex({ cashier: 1 }, { unique: true, partialFilterExpression: { status: "Open" }, name: "one_open_shift" });
  await db.collection("shifts").createIndex({ openedAt: -1 });
  await db.collection("bills").createIndex({ shiftId: 1 });
  await db.collection("purchase_orders").createIndex({ createdAt: -1 });
  await db.collection("stock_counts").createIndex({ at: -1 });
  await db.collection("waste_log").createIndex({ at: -1 });
  // One member per number; an erased member has no number and no longer counts
  await db.collection("customers").createIndex({ phoneIndex: 1 }, { unique: true, partialFilterExpression: { phoneIndex: { $exists: true } }, name: "one_member_per_number" });
  await db.collection("loyalty_ledger").createIndex({ customerId: 1, at: -1 });
  await db.collection("waitlist").createIndex({ createdAt: -1 });
  await db.collection("feedback").createIndex({ at: -1 });
  // One open clock-in per person, so a double tap cannot start two
  await db.collection("timeclock").createIndex({ username: 1 }, { unique: true, partialFilterExpression: { out: null }, name: "one_open_clock" });
  await db.collection("timeclock").createIndex({ in: -1 });
  await db.collection("rota").createIndex({ date: 1, username: 1 });
  await db.collection("leave").createIndex({ username: 1, from: -1 });
  await db.collection("staff_requests").createIndex({ owner: 1, createdAt: -1, seq: -1 });
  await db.collection("staff_requests").createIndex({ status: 1, createdAt: -1, seq: -1 });
  await db.collection("staff_requests").createIndex({ reviewer: 1, createdAt: -1, seq: -1 });
  // One history entry per version: a second change from the same version cannot be recorded twice
  await db.collection("request_history").createIndex({ requestId: 1, version: 1 }, { unique: true });
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
