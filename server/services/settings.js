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
  // Each table has a place on the floor plan: a cell on a 12 × 8 grid, and a shape
  tables: TABLES.map((t, i) => ({ no: t.no, seats: t.seats, area: "Main hall", x: (i % 5) * 2 + 1, y: Math.floor(i / 5) * 3 + 1, shape: t.seats > 4 ? "long" : t.seats <= 2 ? "round" : "square" })),
  discountLimits: { ...DISCOUNT_LIMIT },
  receipt: { header: "Thank you for visiting!", footer: "Prices include tax. Please come again." },
  // Menu categories in the order the POS shows them, and the station that prepares each one.
  // Everything starts at the Kitchen, as before stations existed; an Admin can move drinks to the Bar.
  categories: [
    { name: "Coffee", station: "Kitchen" }, { name: "Tea", station: "Kitchen" }, { name: "Cold Drinks", station: "Kitchen" },
    { name: "Food", station: "Kitchen" }, { name: "Desserts", station: "Kitchen" }
  ],
  orderTypes: { dineIn: true, takeaway: true, delivery: true },
  // A service charge on dine-in bills, and whether a cashier must open a shift before taking money
  serviceChargePct: 0,
  requireShift: false,
  // Loyalty: points earned per Rs 100 paid, and what one point is worth when spent
  loyalty: { enabled: true, earnPer100: 1, pointValue: 1 },
  // Bookings: opening hours, the step between booking times and how long a table is held
  bookings: { open: "10:00", close: "23:00", slotMinutes: 30, durationMinutes: 90 },
  version: 0
});

const DEFAULTS_LOYALTY = Object.freeze({ enabled: true, earnPer100: 1, pointValue: 1 });
const DEFAULTS_BOOKINGS = Object.freeze({ open: "10:00", close: "23:00", slotMinutes: 30, durationMinutes: 90 });
// Tables saved before the floor plan existed get a place in a simple grid
const placed = (t, i) => ({ x: (i % 5) * 2 + 1, y: Math.floor(i / 5) * 3 + 1, shape: t.seats > 4 ? "long" : t.seats <= 2 ? "round" : "square", ...t });
const freeze = (s) => Object.freeze({
  ...s,
  tables: Object.freeze(s.tables.map((t, i) => Object.freeze(placed(t, i)))),
  discountLimits: Object.freeze({ ...s.discountLimits }),
  receipt: Object.freeze({ ...s.receipt }),
  loyalty: Object.freeze({ ...DEFAULTS_LOYALTY, ...(s.loyalty || {}) }),
  bookings: Object.freeze({ ...DEFAULTS_BOOKINGS, ...(s.bookings || {}) }),
  categories: Object.freeze(s.categories.map((c) => Object.freeze({ ...c }))),
  orderTypes: Object.freeze({ ...s.orderTypes })
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
  const serviceRate = () => (current.serviceChargePct || 0) / 100;
  const stationOf = (cat) => {
    const found = current.categories.find((c) => c.name.toLowerCase() === String(cat).toLowerCase());
    return found ? found.station : "Kitchen";
  };
  const hasCategory = (cat) => current.categories.some((c) => c.name.toLowerCase() === String(cat).toLowerCase());
  const typeAllowed = (type) => Boolean(current.orderTypes[{ "dine-in": "dineIn", takeaway: "takeaway", delivery: "delivery" }[type]]);
  const discountLimit = (role) => (Object.hasOwn(current.discountLimits, role) ? current.discountLimits[role] : 0);

  // Open orders keep their table, so a table that is in use cannot be removed
  async function save(req, input) {
    const next = { ...current, ...input };
    delete next.version;
    const numbers = next.tables.map((t) => t.no);
    if (new Set(numbers).size !== numbers.length) throw new AppError(400, "invalid_input", "Each table needs its own number.");
    next.tables = [...next.tables].sort((a, b) => a.no - b.no).map((t, i) => placed(t, i));
    for (const key of ["loyalty", "bookings"]) if (next[key] === undefined) next[key] = current[key];
    const catNames = next.categories.map((c) => c.name.toLowerCase());
    if (new Set(catNames).size !== catNames.length) throw new AppError(400, "invalid_input", "Each category needs its own name.");
    if (!Object.values(next.orderTypes).some(Boolean)) throw new AppError(400, "invalid_input", "Turn on at least one order type.");
    if (next.bookings && next.bookings.open >= next.bookings.close) throw new AppError(400, "invalid_input", "Closing time must be after opening time.");
    const spots = next.tables.map((t) => `${t.area}|${t.x}|${t.y}`);
    if (new Set(spots).size !== spots.length) throw new AppError(400, "invalid_input", "Two tables are on the same spot of the floor plan. Move one of them.");
    if (next.discountLimits.Cashier > next.discountLimits.Manager) throw new AppError(400, "invalid_input", "A cashier's discount limit cannot be higher than a manager's.");

    const saved = await inTransaction(db, async (session) => {
      const removed = current.tables.map((t) => t.no).filter((no) => !numbers.includes(no));
      if (removed.length) {
        const busy = await db.collection("orders").findOne({ table: { $in: removed }, billed: false, status: { $ne: "Cancelled" } }, { session });
        if (busy) throw new AppError(409, "table_in_use", `Table ${busy.table} has open orders, so it cannot be removed yet.`);
      }
      // A category still used by a menu item cannot be removed; rename the items first
      const used = await db.collection("menu").distinct("cat", {}, { session });
      const orphan = used.find((cat) => !catNames.includes(String(cat).toLowerCase()));
      if (orphan) throw new AppError(409, "category_in_use", `Menu items still use the category "${orphan}". Move them to another category first.`);
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

  return { ready, get, tableNumbers, hasTable, taxRate, serviceRate, discountLimit, stationOf, hasCategory, typeAllowed, save };
}

module.exports = { createSettingsService, DEFAULTS };
