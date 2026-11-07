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

function createReservationService({ config, db }) {
  const reservations = db.collection("reservations");

  const context = (field, id) => `reservation-${field}:${id}`;
  const view = (r) => ({
    id: r._id, name: r.nameEnc ? decrypt(r.nameEnc, context("name", r._id), config.data) : "Erased guest", phone: r.phoneMask, date: r.date, time: r.time, party: r.party,
    notes: r.notesEnc ? decrypt(r.notesEnc, context("notes", r._id), config.data) : "", status: r.status,
    createdAt: r.createdAt, updatedAt: r.updatedAt || null, createdBy: r.createdBy
  });

  async function list(query = {}) {
    const filter = {};
    if (query.phone) filter.phoneIndex = blindIndex(query.phone, config.blindIndexKey);
    if (query.date) filter.date = query.date;
    if (query.status) filter.status = query.status;
    // Without a filter, the list is recent and upcoming bookings, so old ones can never push new ones out
    if (!query.phone && !query.date && !query.status) filter.date = { $gte: localDate(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000) };
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
    const [hour, minute] = input.time.split(":").map(Number);
    if (hour < 10 || hour > 23 || minute > 59 || (hour === 23 && minute > 0)) throw new AppError(400, "invalid_input", "Choose a time between 10:00 and 23:00.");

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
      status: online ? "Requested" : "Confirmed", active: true, createdAt: new Date(), createdBy: actor.username
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

  async function setStatus(req, id, status, session) {
    const actor = req.auth.user;
    const current = await reservations.findOne({ _id: id }, { session });
    if (!current) throw new AppError(404, "not_found", "Reservation not found.");
    if (current.erasedAt) throw new AppError(409, "erased", "The guest's details were erased, so this reservation can no longer be changed.");
    if (CLOSED.includes(current.status)) throw new AppError(409, "closed", "Closed reservations cannot be changed.");
    if (current.status === status) throw new AppError(409, "same_status", "Choose a different status.");
    const updated = await reservations.findOneAndUpdate(
      { _id: id, status: current.status },
      { $set: { status, active: !CLOSED.includes(status), updatedAt: new Date() } },
      { returnDocument: "after", session }
    );
    if (!updated) throw new AppError(409, "closed", "This reservation changed. Reload and try again.");
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Reservation status changed", details: `${id} · ${status}`, severity: status === "Cancelled" ? "warning" : "info" }, { session });
    return view(updated);
  }

  async function revealPhone(req, id) {
    const r = await reservations.findOne({ _id: id });
    if (!r || !r.phoneEnc) throw new AppError(404, "not_found", "Reservation not found.");
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Customer phone viewed", details: id, severity: "warning" });
    return decrypt(r.phoneEnc, context("phone", id), config.data);
  }

  return { list, get, create, createOnline, setStatus, revealPhone };
}

module.exports = { createReservationService };
