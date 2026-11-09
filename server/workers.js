// Background jobs. One failing job is logged and never stops the others or the server.
const { verifyChain } = require("./services/auditLog");
const { drainOutbox, releaseStuckMessages, createSimulatedNotifier } = require("./services/outbox");
const { createAlertService } = require("./services/alerts");
const { purgeExpiredData } = require("./services/customers");
const { watchSecuritySettings, checkBackupAge, checkLogReview } = require("./services/opsChecks");

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Raises an alert if the chain is broken. The checkpoint in the log gives an outside copy to compare
// against, which also catches a rollback of the whole log.
async function checkAuditChain({ db, alerts, logger }) {
  const result = await verifyChain(db);
  if (result.ok) {
    if (logger) logger.info({ auditEntries: result.count, auditLastHash: result.lastHash }, "Audit chain verified");
    return result;
  }
  await alerts.raise({ key: "audit-chain", rule: "audit-chain", title: "The audit log failed its integrity check", details: `Entry ${result.brokenAt}: ${result.reason}`, severity: "high" });
  return result;
}

function startWorkers({ config, db, logger }) {
  const alerts = createAlertService({ db, logger });
  const notifier = createSimulatedNotifier(db);
  const context = { config, db, alerts, logger, notifier };

  const jobs = [
    ["notification queue", 10 * SECOND, async () => { await releaseStuckMessages(db); await drainOutbox(context); }],
    ["alert rules", MINUTE, () => alerts.evaluate()],
    ["audit verification", 15 * MINUTE, () => checkAuditChain(context)],
    ["data retention", 60 * MINUTE, () => purgeExpiredData(db, config.retentionDays)],
    ["backup age", 60 * MINUTE, () => checkBackupAge(context)],
    ["audit review reminder", 60 * MINUTE, () => checkLogReview(context)]
  ];
  watchSecuritySettings(context).catch((error) => logger.error({ err: error, job: "security settings" }, "Background job failed"));
  const timers = jobs.map(([name, every, run]) => {
    const timer = setInterval(() => {
      run().catch((error) => logger.error({ err: error, job: name }, "Background job failed"));
    }, every);
    timer.unref();
    return timer;
  });
  return () => timers.forEach(clearInterval);
}

module.exports = { startWorkers, checkAuditChain };
