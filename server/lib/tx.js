// Multi-step changes run in a MongoDB transaction: all of it happens, or none of it does.
const { AppError } = require("./errors");
const { hashToken } = require("./crypto");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

async function inTransaction(db, work) {
  const session = db.client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
    return result;
  } finally {
    await session.endSession();
  }
}

// Runs a change at most once per Idempotency-Key, so a double click or a retry after a network
// failure cannot create a second order, payment or refund. The stored result commits in the same
// transaction as the change, so the two can never disagree. A failed attempt stores nothing.
async function idempotentTransaction(db, req, work) {
  const key = req.get("idempotency-key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError(400, "idempotency_key_required", "This request is missing its unique key. Reload the page and try again.");
  }
  const scope = `${req.auth.user.username}|${req.method}|${req.baseUrl}${req.path}|${key}`;
  const id = hashToken(scope);
  const requestHash = hashToken(JSON.stringify(req.body === undefined ? null : req.body));
  const records = db.collection("idempotency");

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inTransaction(db, async (session) => {
        const existing = await records.findOne({ _id: id }, { session });
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new AppError(422, "idempotency_conflict", "This request key was already used for a different request.");
          }
          return { status: existing.status, body: existing.body, replayed: true };
        }
        const outcome = await work(session);
        const body = JSON.parse(JSON.stringify(outcome.body));
        await records.insertOne({ _id: id, requestHash, status: outcome.status, body, expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS) }, { session });
        return { status: outcome.status, body };
      });
    } catch (error) {
      // Two identical requests raced: the loser retries once and replays the winner's result
      const raced = error.code === 11000 && /idempotency/.test(String(error.message));
      if (!raced || attempt > 0) throw error;
    }
  }
}

async function nextSequence(db, name, start, session) {
  const counter = await db.collection("counters").findOneAndUpdate(
    { _id: name },
    [{ $set: { value: { $add: [{ $ifNull: ["$value", start] }, 1] } } }],
    { upsert: true, returnDocument: "after", session }
  );
  return counter.value;
}

module.exports = { inTransaction, idempotentTransaction, nextSequence };
