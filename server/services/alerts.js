// Security monitoring. Rules read the audit log and raise alerts for an Admin. Repeats update one open
// alert instead of creating new ones, so a flood of minor events cannot bury a real attack.
const { AppError } = require("../lib/errors");
const { randomToken } = require("../lib/crypto");
const { recordEvent } = require("./auditLog");
const { inTransaction } = require("../lib/tx");

const MINUTE = 60 * 1000;

// Each rule: which audit actions it counts, over how long, and how many trigger it for one person, or
// for one network address when groupBy is "ip". Counting by address catches password spraying, where
// an attacker tries one password against many usernames so no single account looks unusual.
const RULES = Object.freeze([
  { id: "failed-sign-ins", title: "Repeated failed sign-ins", actions: ["Sign-in failed", "MFA failed"], windowMs: 10 * MINUTE, threshold: 5, severity: "high" },
  { id: "access-denied", title: "Repeated access denials", actions: ["Access denied"], windowMs: 10 * MINUTE, threshold: 5, severity: "high" },
  { id: "bulk-export", title: "Unusual number of data exports", actions: ["Report exported", "Audit log exported"], windowMs: 60 * MINUTE, threshold: 3, severity: "high" },
  { id: "phone-views", title: "Many customer numbers viewed", actions: ["Customer phone viewed"], windowMs: 60 * MINUTE, threshold: 10, severity: "high" },
  { id: "refund-spike", title: "Unusual number of refunds", actions: ["Refund issued"], windowMs: 60 * MINUTE, threshold: 3, severity: "high" },
  { id: "account-locked", title: "Account locked after failed attempts", actions: ["Account locked"], windowMs: 60 * MINUTE, threshold: 1, severity: "warning" },
  { id: "failed-sign-ins-address", title: "Many failed sign-ins from one network address", actions: ["Sign-in failed", "MFA failed"], windowMs: 10 * MINUTE, threshold: 10, severity: "high", groupBy: "ip" },
  { id: "payment-conflict", title: "A bill may have been paid twice", actions: ["Payment conflict"], windowMs: 24 * 60 * MINUTE, threshold: 1, severity: "high" },
  { id: "gateway-refused", title: "Refused payment gateway callbacks", actions: ["Gateway callback refused", "Gateway callback replayed"], windowMs: 60 * MINUTE, threshold: 3, severity: "high", groupBy: "ip" }
]);

function createAlertService({ db, logger }) {
  const alerts = db.collection("alerts");

  // Opens an alert, or updates the open one with the same key
  async function raise({ key, rule, title, details, severity, count, lastEventAt }) {
    const now = new Date();
    const update = {
      $set: { rule, title, details, severity, lastSeenAt: now, ...(lastEventAt ? { lastEventAt } : {}) },
      $setOnInsert: { _id: randomToken(16), status: "Open", createdAt: now }
    };
    if (count === undefined) update.$inc = { count: 1 }; else update.$set.count = count;
    await alerts.updateOne({ key, status: "Open" }, { ...update, $setOnInsert: { ...update.$setOnInsert, key } }, { upsert: true });
    if (logger) logger.warn({ alert: rule, severity }, title);
  }

  async function evaluate() {
    const now = Date.now();
    for (const rule of RULES) {
      const groups = await db.collection("audit_events").aggregate([
        { $match: { action: { $in: rule.actions }, at: { $gte: new Date(now - rule.windowMs) } } },
        { $group: { _id: rule.groupBy === "ip" ? "$ip" : "$actor", count: { $sum: 1 }, lastEventAt: { $max: "$at" } } },
        { $match: { count: { $gte: rule.threshold } } }
      ]).toArray();
      for (const group of groups) {
        const key = `${rule.id}:${group._id}`;
        // An acknowledged alert only comes back if something new has happened since
        const previous = await alerts.findOne({ key, status: "Acknowledged" }, { sort: { acknowledgedAt: -1 } });
        if (previous && previous.acknowledgedAt >= group.lastEventAt) continue;
        await raise({
          key, rule: rule.id, title: rule.title, severity: rule.severity, count: group.count, lastEventAt: group.lastEventAt,
          details: `${group.count} events ${rule.groupBy === "ip" ? "from address" : "for"} ${group._id || "unknown"} in the last ${Math.round(rule.windowMs / MINUTE)} minutes`
        });
      }
    }
  }

  const view = (a) => ({ id: a._id, rule: a.rule, title: a.title, details: a.details, severity: a.severity, count: a.count, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt });
  const listOpen = async () => (await alerts.find({ status: "Open" }).sort({ lastSeenAt: -1 }).limit(50).toArray()).map(view);

  async function acknowledge(req, id) {
    const actor = req.auth.user;
    await inTransaction(db, async (session) => {
      const result = await alerts.findOneAndUpdate({ _id: id, status: "Open" }, { $set: { status: "Acknowledged", acknowledgedBy: actor.username, acknowledgedAt: new Date() } }, { session });
      if (!result) throw new AppError(404, "not_found", "Alert not found.");
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Alert acknowledged", details: result.title, severity: "warning" }, { session });
    });
  }

  return { raise, evaluate, listOpen, acknowledge };
}

module.exports = { createAlertService, RULES };
