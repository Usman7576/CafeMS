// Operating settings an Admin can change without touching code: tables, tax, discount limits and the
// receipt. They are kept in the "settings" collection and held in memory, so every request reads the
// same values without a database round trip. A save replaces the memory copy only after it commits.
const { AppError } = require("../lib/errors");
const { recordEvent } = require("./auditLog");
const { inTransaction } = require("../lib/tx");
const { TABLES, TAX_RATE, DISCOUNT_LIMIT } = require("../lib/domain");

const DOC_ID = "operations";
const DEFAULTS = Object.freeze({
  taxRatePct: Math.round(TAX_RATE * 100),
  tables: TABLES.map((t) => ({ no: t.no, seats: t.seats, area: "Main hall" })),
  discountLimits: { ...DISCOUNT_LIMIT },
  receipt: { header: "Thank you for visiting!", footer: "Prices include tax. Please come again." },
  version: 0
});

const freeze = (s) => Object.freeze({
  ...s,
  tables: Object.freeze(s.tables.map((t) => Object.freeze({ ...t }))),
  discountLimits: Object.freeze({ ...s.discountLimits }),
  receipt: Object.freeze({ ...s.receipt })
});

function createSettingsService({ db }) {
  const settings = db.collection("settings");
  let current = freeze(DEFAULTS);
  let loading = null;

  // Read once, on the first request after start-up
  function ready() {
    if (!loading) {
      loading = settings.findOne({ _id: DOC_ID }).then((doc) => {
        if (doc) {
          const saved = { ...doc };
          delete saved._id;
          current = freeze({ ...DEFAULTS, ...saved });
        }
      }).catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  }

  const get = () => current;
  const tableNumbers = () => current.tables.map((t) => t.no);
  const hasTable = (no) => current.tables.some((t) => t.no === no);
  const taxRate = () => current.taxRatePct / 100;
  const discountLimit = (role) => (Object.hasOwn(current.discountLimits, role) ? current.discountLimits[role] : 0);

  // Open orders keep their table, so a table that is in use cannot be removed
  async function save(req, input) {
    const next = { ...current, ...input };
    delete next.version;
    const numbers = next.tables.map((t) => t.no);
    if (new Set(numbers).size !== numbers.length) throw new AppError(400, "invalid_input", "Each table needs its own number.");
    next.tables = [...next.tables].sort((a, b) => a.no - b.no);
    if (next.discountLimits.Cashier > next.discountLimits.Manager) throw new AppError(400, "invalid_input", "A cashier's discount limit cannot be higher than a manager's.");

    const saved = await inTransaction(db, async (session) => {
      const removed = current.tables.map((t) => t.no).filter((no) => !numbers.includes(no));
      if (removed.length) {
        const busy = await db.collection("orders").findOne({ table: { $in: removed }, billed: false, status: { $ne: "Cancelled" } }, { session });
        if (busy) throw new AppError(409, "table_in_use", `Table ${busy.table} has open orders, so it cannot be removed yet.`);
      }
      const result = await settings.findOneAndUpdate(
        { _id: DOC_ID, $or: [{ version: input.version }, ...(input.version === 0 ? [{ version: { $exists: false } }] : [])] },
        { $set: { ...next, updatedAt: new Date(), updatedBy: req.auth.user.username }, $inc: { version: 1 } },
        { upsert: input.version === 0, returnDocument: "after", session }
      ).catch((error) => {
        if (error.code === 11000) return null;
        throw error;
      });
      if (!result) throw new AppError(409, "stale_version", "Someone else changed the settings. Reload the page and try again.");
      await recordEvent(db, req, {
        actor: req.auth.user.username, role: req.auth.user.role, action: "Settings changed",
        details: `Tax ${next.taxRatePct}% · ${next.tables.length} tables · discounts ${next.discountLimits.Cashier}%/${next.discountLimits.Manager}%`, severity: "warning"
      }, { session });
      return result;
    });
    const doc = { ...saved };
    delete doc._id;
    delete doc.updatedAt;
    delete doc.updatedBy;
    current = freeze({ ...DEFAULTS, ...doc });
    return current;
  }

  return { ready, get, tableNumbers, hasTable, taxRate, discountLimit, save };
}

module.exports = { createSettingsService, DEFAULTS };
