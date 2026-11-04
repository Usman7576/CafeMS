const { MongoClient } = require("mongodb");

function createClient(config) {
  return new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 20000,
    maxPoolSize: 20
  });
}

async function ensureIndexes(db) {
  await db.collection("users").createIndex({ username: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ jti: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ sid: 1 }, { unique: true });
  await db.collection("sessions").createIndex({ username: 1 });
  await db.collection("sessions").createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_tokens").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("auth_tokens").createIndex({ username: 1 });
  await db.collection("audit_events").createIndex({ at: -1 });
}

module.exports = { createClient, ensureIndexes };
