// Reservations. Guest name, phone and notes are encrypted at rest. A keyed index lets staff search
// by an exact number and detect duplicates without decrypting anything.
const { AppError } = require("../lib/errors");
const { maskPhone, localDate, isRealDate } = require("../lib/domain");
const { encrypt, decrypt, blindIndex } = require("../lib/crypto");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");
const { enqueue } = require("./outbox");

const CLOSED = ["Completed", "Cancelled"];
const ONLINE_DAYS_AHEAD = 60;
// The staff screen shows bookings from this many days ago onwards; older ones are found by phone search
const RECENT_DAYS = 30;

const ACTIVE = ["Requested", "Confirmed", "Seated"];
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
// Minutes since midnight in Pakistan time (UTC+5, no daylight saving), the same clock as localDate
const nowMinutes = (d) => { const pk = new Date(d.getTime() + 5 * 60 * 60 * 1000); return pk.getUTCHours() * 60 + pk.getUTCMinutes(); };
const toTime = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function createReservationService({ config, db, settings }) {
  const reservations = db.collection("reservations");

  // ---------- Time slots and tables ----------
  // Booking times run from opening, every slot, until a full booking would end at closing
  function slots() {
    const b = settings.get().bookings;
    const list = [];
    for (let t = toMin(b.open); t + b.durationMinutes <= toMin(b.close); t += b.slotMinutes) list.push(toTime(t));
    return list;
  }

  // Finds the smallest free table for a party at a time. Bookings that overlap are held first: those
  // with a table keep it, the rest are given the smallest table that fits, largest parties first.
  async function freeTable(date, time, party, excludeId, session) {
    const { durationMinutes } = settings.get().bookings;
    const start = toMin(time);
    const tables = [...settings.get().tables].sort((a, b) => a.seats - b.seats || a.no - b.no);
    const others = (await reservations.find({ date, status: { $in: ACTIVE }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }, { session }).toArray())
      .filter((r) => Math.abs(toMin(r.time) - start) < durationMinutes);
    const taken = new Set(others.filter((r) => r.table).map((r) => r.table));
    for (const r of others.filter((x) => !x.table).sort((a, b) => b.party - a.party)) {
      const t = tables.find((x) => x.seats >= r.party && !taken.has(x.no));
      if (t) taken.add(t.no);
    }
    const t = tables.find((x) => x.seats >= party && !taken.has(x.no));
    return t ? t.no : null;
  }

  async function availability(date, party) {
    if (!isRealDate(date) || date < localDate()) return [];
    const list = [];
    const now = new Date();
    const today = date === localDate();
    for (const time of slots()) {
      // Times already past today are not offered
      if (today && toMin(time) <= nowMinutes(now)) continue;
      list.push({ time, available: (await freeTable(date, time, party)) !== null });
    }
    return list;
  }

  const context = (field, id) => `reservation-${field}:${id}`;
  const view = (r) => ({
    id: r._id, name: r.nameEnc ? decrypt(r.nameEnc, context("name", r._id), config.data) : "Erased guest", phone: r.phoneMask, date: r.date, time: r.time, party: r.party,
    notes: r.notesEnc ? decrypt(r.notesEnc, context("notes", r._id), config.data) : "", status: r.status, table: r.table || null,
    createdAt: r.createdAt, updatedAt: r.updatedAt || null, createdBy: r.createdBy
  });

  async function list(query = {}) {
    const filter = {};
    if (query.phone) filter.phoneIndex = blindIndex(query.phone, config.blindIndexKey);
    if (query.date) filter.date = query.date;
    if (query.status) filter.status = query.status;
    // Without a filter, upcoming bookings and recent ones are fetched separately, so neither can push
    // the other off the staff screen
    if (!query.phone && !query.date && !query.status) {
      const today = localDate();
      const [recent, upcoming] = await Promise.all([
        reservations.find({ date: { $gte: localDate(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000), $lt: today } }).sort({ date: -1, time: -1 }).limit(100).toArray(),
        reservations.find({ date: { $gte: today } }).sort({ date: 1, time: 1 }).limit(400).toArray()
      ]);
      return [...recent.reverse(), ...upcoming].map(view);
    }
    const rows = await reservations.find(filter).sort({ date: 1, time: 1 }).limit(500).toArray();
    return rows.map(view);
  }

  async function get(id) {
    const r = await reservations.findOne({ _id: id });
    if (!r) throw new AppError(404, "not_found", "Reservation not found.");
    return view(r);
  }

  async function create(req, input, session, online = false) {
    const actor = online ? { username: "online", role: "" } : req.auth.user;
    if (!isRealDate(input.date)) throw new AppError(400, "invalid_input", "Choose a valid reservation date.");
    if (input.date < localDate()) throw new AppError(400, "invalid_input", "Reservations cannot be made for a past date.");
    const times = slots();
    if (!times.includes(input.time)) throw new AppError(400, "invalid_input", `Choose a booking time between ${times[0]} and ${times[times.length - 1]}, every ${settings.get().bookings.slotMinutes} minutes.`);
    const table = await freeTable(input.date, input.time, input.party, null, session);
    if (table === null) throw new AppError(409, "fully_booked", `There is no table for ${input.party} at ${input.time} on that day. Please choose another time.`);

    const phoneIndex = blindIndex(input.phone, config.blindIndexKey);
    // A unique index also enforces this, so two simultaneous requests cannot both succeed
    if (await reservations.findOne({ phoneIndex, date: input.date, time: input.time, active: true }, { session })) {
      throw new AppError(409, "duplicate", "This guest already has an active reservation at that time.");
    }

    const id = `R-${await nextSequence(db, "reservation", 1000, session)}`;
    const doc = {
      _id: id, nameEnc: encrypt(input.name, context("name", id), config.data), phoneEnc: encrypt(input.phone, context("phone", id), config.data),
      phoneIndex, phoneMask: maskPhone(input.phone), date: input.date, time: input.time, party: input.party,
      notesEnc: input.notes ? encrypt(input.notes, context("notes", id), config.data) : null,
      // A booking staff make is confirmed with a table at once; an online request gets one when confirmed
      status: online ? "Requested" : "Confirmed", ...(online ? {} : { table }), active: true, createdAt: new Date(), createdBy: actor.username
    };
    await reservations.insertOne(doc, { session });
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: online ? "Online reservation requested" : "Reservation created", details: `${id} · ${input.date} ${input.time}` }, { session });
    if (online) await enqueue(db, "reservation-request", { reservation: id }, session);
    return view(doc);
  }

  // A customer's request waits for staff to confirm it. A repeat of an existing booking is not an error
  // to the customer, because saying so would reveal that someone with that number has booked.
  async function createOnline(req, input) {
    const latest = localDate(Date.now() + ONLINE_DAYS_AHEAD * 24 * 60 * 60 * 1000);
    if (input.date > latest) throw new AppError(400, "invalid_input", `Online bookings can be made up to ${ONLINE_DAYS_AHEAD} days ahead. Please call us for later dates.`);
    try {
      await inTransaction(db, (session) => create(req, input, session, true));
    } catch (error) {
      if (error.code !== "duplicate" && error.code !== 11000) throw error;
    }
  }

  async function setStatus(req, id, status, session, chosenTable) {
    const actor = req.auth.user;
    const current = await reservations.findOne({ _id: id }, { session });
    if (!current) throw new AppError(404, "not_found", "Reservation not found.");
    if (current.erasedAt) throw new AppError(409, "erased", "The guest's details were erased, so this reservation can no longer be changed.");
    if (CLOSED.includes(current.status)) throw new AppError(409, "closed", "Closed reservations cannot be changed.");
    if (current.status === status) throw new AppError(409, "same_status", "Choose a different status.");
    // Confirming or seating a booking gives it a table: the one chosen, if free, or the smallest that fits
    let table = current.table || null;
    if (["Confirmed", "Seated"].includes(status) && (chosenTable || !table)) {
      const free = await freeTable(current.date, current.time, current.party, id, session);
      if (chosenTable) {
        const t = settings.get().tables.find((x) => x.no === chosenTable);
        if (!t || t.seats < current.party) throw new AppError(400, "invalid_input", `Table ${chosenTable} does not seat ${current.party}.`);
        const clash = await reservations.findOne({ _id: { $ne: id }, date: current.date, table: chosenTable, status: { $in: ACTIVE } }, { session });
        if (clash && Math.abs(toMin(clash.time) - toMin(current.time)) < settings.get().bookings.durationMinutes) throw new AppError(409, "table_booked", `Table ${chosenTable} is booked at ${clash.time}.`);
        table = chosenTable;
      } else {
        if (free === null) throw new AppError(409, "fully_booked", "No table is free for this booking. Choose one by hand or change the time.");
        table = free;
      }
    }
    const updated = await reservations.findOneAndUpdate(
      { _id: id, status: current.status },
      { $set: { status, active: !CLOSED.includes(status), updatedAt: new Date(), ...(table ? { table } : {}) } },
      { returnDocument: "after", session }
    );
    if (!updated) throw new AppError(409, "closed", "This reservation changed. Reload and try again.");
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Reservation status changed", details: `${id} · ${status}${table ? ` · Table ${table}` : ""}`, severity: status === "Cancelled" ? "warning" : "info" }, { session });
    return view(updated);
  }

  async function revealPhone(req, id) {
    const r = await reservations.findOne({ _id: id });
    if (!r || !r.phoneEnc) throw new AppError(404, "not_found", "Reservation not found.");
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Customer phone viewed", details: id, severity: "warning" });
    return decrypt(r.phoneEnc, context("phone", id), config.data);
  }

  return { list, get, create, createOnline, setStatus, revealPhone, availability, slots };
}

module.exports = { createReservationService };
