// Menu photo storage. Files live outside the web root under random names. The type is checked against
// the file's own first bytes, which refuses a renamed script; files are also served so they cannot run.
const fs = require("fs/promises");
const path = require("path");
const { randomToken } = require("../lib/crypto");
const { AppError } = require("../lib/errors");
const { recordEvent } = require("./auditLog");
const { inTransaction } = require("../lib/tx");

const SAFE_FILE = /^[A-Za-z0-9_-]{20,64}\.(?:png|jpg|webp)$/;
const TYPES = Object.freeze({
  "image/png": { ext: "png", matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: "jpg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: "webp", matches: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }
});

function createPhotoService({ config, db }) {
  const menu = db.collection("menu");

  function filePath(name) {
    if (!SAFE_FILE.test(name)) throw new AppError(404, "not_found", "Photo not found.");
    return path.join(config.uploadDir, name);
  }

  async function remove(name) {
    if (name) await fs.rm(filePath(name), { force: true });
  }

  async function save(req, id, contentType, body) {
    const type = Object.hasOwn(TYPES, contentType) ? TYPES[contentType] : null;
    if (!type || !Buffer.isBuffer(body) || !type.matches(body)) {
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Upload refused", details: `Menu item ${id}: not a valid image`, severity: "warning" });
      throw new AppError(415, "bad_file", "Choose a PNG, JPEG or WebP image.");
    }
    const item = await menu.findOne({ _id: id });
    if (!item) throw new AppError(404, "not_found", "Item not found.");

    // The folder is fixed by configuration (and must be outside public/); the name is random and
    // checked against SAFE_FILE by filePath, so neither can come from the request.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(config.uploadDir, { recursive: true });
    const name = `${randomToken(24)}.${type.ext}`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.writeFile(filePath(name), body, { flag: "wx", mode: 0o640 });
    try {
      await inTransaction(db, async (session) => {
        await menu.updateOne({ _id: id }, { $set: { photo: { file: name, type: contentType } } }, { session });
        await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Menu photo changed", details: item.name, severity: "info" }, { session });
      });
    } catch (error) {
      await remove(name);
      throw error;
    }
    await remove(item.photo && item.photo.file);
  }

  async function read(id) {
    const item = await menu.findOne({ _id: id });
    if (!item || !item.photo) throw new AppError(404, "not_found", "Photo not found.");
    return { path: filePath(item.photo.file), type: item.photo.type };
  }

  return { save, read, remove };
}

module.exports = { createPhotoService };
