// Notification queue (soft async): the action saves a message in the same transaction and carries on,
// and a worker delivers it later. Failed messages are retried, then raise an alert, so a lost
// notification is noticed rather than discovered days later.
const { randomToken } = require("../lib/crypto");

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30 * 1000;

async function enqueue(db, type, payload, session) {
  await db.collection("outbox").insertOne({
    _id: randomToken(16), type, payload, status: "Pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date()
  }, { session });
}

// Simulated delivery, as this project has no SMS or email provider. No phone numbers are logged.
function createSimulatedNotifier(db) {
  return {
    deliver: (message) => db.collection("notifications").insertOne({ type: message.type, payload: message.payload, deliveredAt: new Date() })
  };
}

async function drainOutbox({ db, notifier, alerts, logger }, limit = 25) {
  const outbox = db.collection("outbox");
  let delivered = 0;
  for (let i = 0; i < limit; i += 1) {
    // Claiming with one atomic update means two workers can never send the same message
    const message = await outbox.findOneAndUpdate(
      { status: "Pending", nextAttemptAt: { $lte: new Date() } },
      { $set: { status: "Sending", claimedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" }
    );
    if (!message) break;
    try {
      await notifier.deliver(message);
      await outbox.updateOne({ _id: message._id }, { $set: { status: "Sent", sentAt: new Date() } });
      delivered += 1;
    } catch (error) {
      if (logger) logger.warn({ err: error, type: message.type, attempts: message.attempts }, "Notification failed");
      if (message.attempts >= MAX_ATTEMPTS) {
        await outbox.updateOne({ _id: message._id }, { $set: { status: "Failed", failedAt: new Date() } });
        await alerts.raise({ key: `notification-failed:${message.type}`, rule: "notification-failed", title: "Notifications are not being delivered", details: `A ${message.type} message failed ${message.attempts} times`, severity: "warning" });
      } else {
        await outbox.updateOne({ _id: message._id }, { $set: { status: "Pending", nextAttemptAt: new Date(Date.now() + RETRY_BASE_MS * 2 ** (message.attempts - 1)) } });
      }
    }
  }
  return delivered;
}

// A worker that crashes mid-send must not strand its message
async function releaseStuckMessages(db) {
  await db.collection("outbox").updateMany(
    { status: "Sending", claimedAt: { $lte: new Date(Date.now() - 5 * 60 * 1000) } },
    { $set: { status: "Pending", nextAttemptAt: new Date() } }
  );
}

module.exports = { enqueue, createSimulatedNotifier, drainOutbox, releaseStuckMessages, MAX_ATTEMPTS };
