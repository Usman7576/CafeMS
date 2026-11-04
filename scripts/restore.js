// Usage: npm run restore -- <backup file> <empty target database name>
require("dotenv").config({ quiet: true });
const path = require("path");
const { loadConfig } = require("../server/config");
const { createClient } = require("../server/db");
const { restoreBackup, parseBackupKey } = require("../server/lib/backup");

(async () => {
  const [file, target] = process.argv.slice(2);
  if (!file || !target) throw new Error("Give the backup file and an empty target database name.");
  const config = loadConfig(process.env);
  const key = parseBackupKey(process.env.BACKUP_KEY);
  const client = createClient(config);
  await client.connect();
  try {
    const manifest = await restoreBackup({ backupPath: path.resolve(file), key, db: client.db(target), uploadDir: config.uploadDir });
    console.log(`Restored backup from ${manifest.createdAt} into ${target}. All record counts match.`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
});
