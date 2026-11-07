// The cafe's public details, shown on the website and receipts and edited by an Admin.
const { recordEvent } = require("./auditLog");
const { inTransaction } = require("../lib/tx");

const DEFAULTS = Object.freeze({
  name: "CafeMS",
  tagline: "Good coffee. A warm welcome.",
  about: "Sit down, slow down and let us look after you. Great coffee, simple food and a table with your name on it.",
  address: "",
  phone: "",
  hours: "Every day, 10:00 to 23:00"
});

function createCafeService({ db }) {
  const settings = db.collection("settings");

  async function get() {
    const doc = await settings.findOne({ _id: "cafe" });
    const { _id, ...saved } = doc || {};
    return { ...DEFAULTS, ...saved };
  }

  async function save(req, details) {
    await inTransaction(db, async (session) => {
      await settings.updateOne({ _id: "cafe" }, { $set: details }, { upsert: true, session });
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Cafe details changed", details: details.name, severity: "warning" }, { session });
    });
    return get();
  }

  return { get, save };
}

module.exports = { createCafeService, DEFAULTS };
