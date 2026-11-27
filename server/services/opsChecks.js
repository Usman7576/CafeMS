// Monitoring that cannot come from the audit log alone: security settings that changed between starts,
// and backups that have stopped. An insider who turns off the nightly backup leaves no entry to count.
const { recordEvent } = require("./auditLog");

const HOUR = 60 * 60 * 1000;
const STATUS = "system_status";
const DAY = 24 * HOUR;
const ACKNOWLEDGED_FOR = DAY;

// Only names and values that are safe to store. Key IDs are recorded, never the keys.
function securitySettings(config) {
  const values = {
    environment: config.env, origin: config.appOrigin, tls: config.usesTls, trustedProxies: config.trustProxy,
    retentionDays: config.retentionDays, refundApprovalLimit: config.refundApprovalLimit, refundWindowDays: config.refundWindowDays,
    backupMaxAgeHours: config.backupMaxAgeHours, logReviewDays: config.logReviewDays,
    activeSessionKey: config.jwt.activeId, activeDataKey: config.data.activeId, activeAuditKey: config.audit.activeId
  };
  for (const [name, value] of Object.entries(config.limits)) values[`limits_${name}`] = value;
  for (const [name, value] of Object.entries(config.auth)) values[`auth_${name}`] = value;
  return values;
}

// Compares this start's settings with the last ones seen, and records the names of any that differ
async function watchSecuritySettings({ config, db }) {
  const status = db.collection(STATUS);
  const current = securitySettings(config);
  const stored = await status.findOne({ _id: "security-settings" });
  if (!stored) {
    await status.insertOne({ _id: "security-settings", values: current, firstSeenAt: new Date() });
    return [];
  }
  const names = [...new Set([...Object.keys(current), ...Object.keys(stored.values)])].filter((name) => current[name] !== stored.values[name]).sort();
  if (!names.length) return [];
  await recordEvent(db, null, { actor: "system", action: "Security settings changed", details: names.join(", "), severity: "high" });
  await status.updateOne({ _id: "security-settings" }, { $set: { values: current, changedAt: new Date() } });
  return names;
}

// Run by the backup script after a backup has been written
async function recordBackupSuccess(db, sha256) {
  await db.collection(STATUS).updateOne({ _id: "backup" }, { $set: { lastSuccessAt: new Date(), sha256 } }, { upsert: true });
}

// A new deployment is measured from its first start, so one that never backs up is caught as well
async function checkBackupAge({ config, db, alerts, now = Date.now() }) {
  if (!config.backupMaxAgeHours) return false;
  const status = db.collection(STATUS);
  const backup = await status.findOne({ _id: "backup" });
  const settings = backup ? null : await status.findOne({ _id: "security-settings" });
  const since = backup ? backup.lastSuccessAt : settings && settings.firstSeenAt;
  if (!since) return false;
  const hours = Math.floor((now - since.getTime()) / HOUR);
  if (hours <= config.backupMaxAgeHours) return false;
  return raiseOnce({ db, alerts, now }, {
    key: "backup-stale", title: "Backups have stopped", severity: "high", count: hours,
    details: backup ? `The last successful backup was ${hours} hours ago` : `No backup has been recorded in ${hours} hours`
  });
}

// An acknowledged reminder stays quiet for a day rather than returning at the next hourly check
async function raiseOnce({ db, alerts, now }, alert) {
  const acknowledged = await db.collection("alerts").findOne({ key: alert.key, status: "Acknowledged", acknowledgedAt: { $gt: new Date(now - ACKNOWLEDGED_FOR) } });
  if (acknowledged) return false;
  await alerts.raise({ ...alert, rule: alert.key });
  return true;
}

// The audit log is only useful if someone reads it, so a review that is overdue raises a reminder
async function checkLogReview({ config, db, alerts, now = Date.now() }) {
  if (!config.logReviewDays) return false;
  const latest = await db.collection("audit_events").findOne({ action: "Audit log reviewed", seq: { $exists: true } }, { sort: { at: -1 } });
  const settings = latest ? null : await db.collection(STATUS).findOne({ _id: "security-settings" });
  const since = latest ? latest.at : settings && settings.firstSeenAt;
  if (!since) return false;
  const days = Math.floor((now - since.getTime()) / DAY);
  if (days <= config.logReviewDays) return false;
  return raiseOnce({ db, alerts, now }, {
    key: "log-review-due", title: "The audit log needs its weekly review", severity: "warning", count: days,
    details: latest ? `Last reviewed ${days} days ago by ${latest.actor}` : `Not reviewed in the ${days} days since this server started`
  });
}

module.exports = { securitySettings, watchSecuritySettings, recordBackupSuccess, checkBackupAge, checkLogReview };
