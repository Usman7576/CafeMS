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
  "reservations", "tables", "counters", "settings", "approvals", "idempotency"];

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
  await db.collection("audit_events").createIndex({ at: -1 });
  await db.collection("orders").createIndex({ waiter: 1, createdAt: -1 });
  await db.collection("orders").createIndex({ table: 1, billed: 1 });
  await db.collection("orders").createIndex({ status: 1, updatedAt: 1 });
  await db.collection("bills").createIndex({ createdAt: -1 });
  await db.collection("reservations").createIndex({ date: 1, time: 1 });
  await db.collection("reservations").createIndex({ phoneIndex: 1, date: 1, time: 1 }, { unique: true, partialFilterExpression: { active: true } });
  await db.collection("approvals").createIndex({ status: 1, createdAt: -1 });
  await db.collection("idempotency").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

module.exports = { createClient, ensureIndexes, assertTransactionsAvailable };
