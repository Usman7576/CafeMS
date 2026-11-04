// Usage: npm run backup [-- <folder>]   Default folder: backups (ignored by git)
require("dotenv").config({ quiet: true });
const path = require("path");
const { loadConfig } = require("../server/config");
const { createClient } = require("../server/db");
const { createBackup, parseBackupKey } = require("../server/lib/backup");

(async () => {
  const config = loadConfig(process.env);
  const key = parseBackupKey(process.env.BACKUP_KEY);
  const client = createClient(config);
  await client.connect();
  try {
    const result = await createBackup({ db: client.db(config.mongoDb), key, directory: path.resolve(process.argv[2] || "backups"), uploadDir: config.uploadDir });
    console.log(`Backup written: ${result.path}`);
    console.log(`SHA-256: ${result.sha256}`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
});
