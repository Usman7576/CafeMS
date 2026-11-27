// Usage: npm run restore -- <backup file> <empty target database name>
require("dotenv").config({ quiet: true });
const path = require("path");
const { loadConfig } = require("../server/config");
const { createClient } = require("../server/db");
const { restoreBackup, parseBackupKey } = require("../server/lib/backup");
const { bindAudit, verifyChain } = require("../server/services/auditLog");

(async () => {
  const [file, target] = process.argv.slice(2);
  if (!file || !target) throw new Error("Give the backup file and an empty target database name.");
  const config = loadConfig(process.env);
  const key = parseBackupKey(process.env.BACKUP_KEY);
  const client = createClient(config);
  await client.connect();
  try {
    const db = client.db(target);
    const manifest = await restoreBackup({ backupPath: path.resolve(file), key, db, uploadDir: config.uploadDir });
    bindAudit(db, config);
    const chain = await verifyChain(db);
    if (!chain.ok) throw new Error(`The restored audit log failed its check at entry ${chain.brokenAt}: ${chain.reason}`);
    console.log(`Restored backup from ${manifest.createdAt} into ${target}. All record counts match, and the audit chain verifies (${chain.count} entries).`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
});
