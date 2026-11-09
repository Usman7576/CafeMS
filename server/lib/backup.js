/* eslint-disable security/detect-non-literal-fs-filename -- backup and restore paths come from the
   operator's command line and the configured upload folder, never from a web request; restored file
   names are reduced to their base name. */
// Encrypted backups. A backup is compressed, then encrypted with AES-256-GCM, and its SHA-256 is kept
// in a manifest. A stolen backup is unreadable, and a damaged or altered one is refused before restore.
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { BSON } = require("mongodb");

const MAGIC = Buffer.from("CAFEMSBK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function parseBackupKey(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== 32 || new Set(key).size < 16) throw new Error("BACKUP_KEY must be 32 random bytes in base64. Run: npm run setup:env");
  return key;
}

async function readUploads(uploadDir) {
  const files = Object.create(null);
  const names = await fs.readdir(uploadDir).catch(() => []);
  for (const name of names) files[name] = (await fs.readFile(path.join(uploadDir, name))).toString("base64");
  return files;
}

async function createBackup({ db, key, directory, uploadDir }) {
  const collections = Object.create(null);
  const counts = Object.create(null);
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    collections[name] = await db.collection(name).find().toArray();
    counts[name] = collections[name].length;
  }
  const createdAt = new Date().toISOString();
  const plain = Buffer.from(BSON.EJSON.stringify({ createdAt, collections, uploads: uploadDir ? await readUploads(uploadDir) : {} }, { relaxed: false }));

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  const file = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const base = `cafems-${createdAt.replace(/[:.]/g, "-")}`;
  const backupPath = path.join(directory, `${base}.bak`);
  await fs.writeFile(backupPath, file, { mode: 0o600 });
  await fs.writeFile(`${backupPath}.manifest.json`, JSON.stringify({ file: `${base}.bak`, sha256: sha256(file), createdAt, counts }, null, 2), { mode: 0o600 });
  return { path: backupPath, sha256: sha256(file), counts };
}

async function readBackup(backupPath, key) {
  const file = await fs.readFile(backupPath);
  const manifest = JSON.parse(await fs.readFile(`${backupPath}.manifest.json`, "utf8"));
  if (sha256(file) !== manifest.sha256) throw new Error("This backup does not match its checksum, so it was damaged or altered.");
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This is not a CafeMS backup.");

  const iv = file.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = file.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  let compressed;
  try {
    compressed = Buffer.concat([decipher.update(file.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch (error) {
    throw new Error("This backup could not be decrypted. The key is wrong or the file was altered.");
  }
  return { manifest, data: BSON.EJSON.parse(zlib.gunzipSync(compressed).toString("utf8"), { relaxed: false }) };
}

// Refuses a database that already holds data, so a restore cannot silently overwrite live records
async function restoreBackup({ backupPath, key, db, uploadDir }) {
  const { manifest, data } = await readBackup(backupPath, key);
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (await db.collection(name).estimatedDocumentCount()) throw new Error(`The target database is not empty (${name}). Restore into an empty database.`);
  }
  for (const [name, rows] of Object.entries(data.collections)) {
    if (rows.length) await db.collection(name).insertMany(rows);
  }
  if (uploadDir) {
    await fs.mkdir(uploadDir, { recursive: true });
    for (const [name, content] of Object.entries(data.uploads || {})) {
      await fs.writeFile(path.join(uploadDir, path.basename(name)), Buffer.from(content, "base64"), { mode: 0o640 });
    }
  }
  for (const [name, count] of Object.entries(manifest.counts)) {
    const restored = await db.collection(name).countDocuments();
    if (restored !== count) throw new Error(`Restore check failed for ${name}: expected ${count}, found ${restored}.`);
  }
  return manifest;
}

module.exports = { createBackup, readBackup, restoreBackup, parseBackupKey };
