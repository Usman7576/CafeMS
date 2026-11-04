// Business constants and calculations, kept in one place on the server.
const TAX_RATE = 0.16;
const TIME_ZONE_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan Standard Time, UTC+5, with no daylight saving

const TABLES = Object.freeze([
  { no: 1, seats: 2 }, { no: 2, seats: 2 }, { no: 3, seats: 4 }, { no: 4, seats: 4 }, { no: 5, seats: 4 },
  { no: 6, seats: 4 }, { no: 7, seats: 6 }, { no: 8, seats: 2 }, { no: 9, seats: 4 }, { no: 10, seats: 8 }
]);
const TABLE_NUMBERS = Object.freeze(TABLES.map((t) => t.no));

const DISCOUNT_LIMIT = Object.freeze({ Cashier: 10, Manager: 25 });
const ACTIVE_ORDER_STATUSES = Object.freeze(["Placed", "Preparing", "Ready"]);

function calculateTotals(lines, discountPct = 0) {
  const sub = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const discount = Math.round((sub * discountPct) / 100);
  const tax = Math.round((sub - discount) * TAX_RATE);
  return { sub, discount, tax, total: sub - discount + tax, count: lines.reduce((sum, l) => sum + l.qty, 0) };
}

// "03001234567" becomes "0300-•••••67"
function maskPhone(phone) {
  return phone ? `${phone.slice(0, 4)}-•••••${phone.slice(-2)}` : "";
}

function localDate(timestamp = Date.now()) {
  return new Date(timestamp + TIME_ZONE_OFFSET_MS).toISOString().slice(0, 10);
}

function dayRange(date) {
  const start = Date.parse(`${date}T00:00:00.000Z`) - TIME_ZONE_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60 * 1000) };
}

function localHour(timestamp) {
  return new Date(new Date(timestamp).getTime() + TIME_ZONE_OFFSET_MS).getUTCHours();
}

function isRealDate(date) {
  const value = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10) === date;
}

// Stock is held in whole thousandths, so repeated decimal arithmetic cannot drift
const toMilli = (quantity) => Math.round(quantity * 1000);
const fromMilli = (milli) => milli / 1000;

module.exports = {
  TAX_RATE, TABLES, TABLE_NUMBERS, DISCOUNT_LIMIT, ACTIVE_ORDER_STATUSES,
  calculateTotals, maskPhone, localDate, dayRange, localHour, isRealDate, toMilli, fromMilli
};
