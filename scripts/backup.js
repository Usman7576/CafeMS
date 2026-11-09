// Usage: npm run backup [-- <folder>]   Default folder: backups (ignored by git)
require("dotenv").config({ quiet: true });
const path = require("path");
const { loadConfig } = require("../server/config");
const { createClient } = require("../server/db");
const { createBackup, parseBackupKey, pruneBackups } = require("../server/lib/backup");
const { recordBackupSuccess } = require("../server/services/opsChecks");

const KEEP_DAYS = 30;

(async () => {
  const config = loadConfig(process.env);
  const key = parseBackupKey(process.env.BACKUP_KEY);
  const client = createClient(config);
  await client.connect();
  try {
    const directory = path.resolve(process.argv[2] || "backups");
    const result = await createBackup({ db: client.db(config.mongoDb), key, directory, uploadDir: config.uploadDir });
    const removed = await pruneBackups(directory, KEEP_DAYS);
    if (removed.length) console.log(`Removed ${removed.length} files older than ${KEEP_DAYS} days.`);
    console.log(`Backup written: ${result.path}`);
    console.log(`SHA-256: ${result.sha256}`);
    // The backup itself has succeeded by now, so a problem here is reported and does not fail it
    await recordBackupSuccess(client.db(config.mongoDb), result.sha256).catch((error) => console.error(`Could not record the backup time: ${error.message}`));
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
});
