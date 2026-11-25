// People: the time clock, weekly timesheets, the rota, leave requests and how the day's tips are
// shared. A week runs Monday to Sunday in the cafe's time zone (Pakistan, UTC+5).
const { AppError } = require("../lib/errors");
const { localDate, dayRange, isRealDate } = require("../lib/domain");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");
const { checkPin } = require("./pins");

const DAY = 24 * 60 * 60 * 1000;
const ON_SHIFT_ROLES = ["Waiter", "Barista", "Kitchen", "Cashier", "Manager"];

// The Monday of the week a date falls in, and the seven dates from it
function weekOf(date) {
  const d = new Date(`${date}T12:00:00.000Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * DAY).toISOString().slice(0, 10));
}
const minutesBetween = (a, b) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

function createPeopleService({ db }) {
  const clock = db.collection("timeclock");
  const rota = db.collection("rota");
  const leave = db.collection("leave");
  const users = db.collection("users");
  const bills = db.collection("bills");

  const audit = (req, action, details, session, severity = "info", actor) => recordEvent(db, req, { actor: actor ? actor.username : req.auth.user.username, role: actor ? actor.role : req.auth.user.role, action, details, severity }, { session });
  const names = async () => new Map((await users.find({}, { projection: { username: 1, name: 1, role: 1 } }).toArray()).map((u) => [u.username, u]));
  const entryView = (e, who) => ({ id: e._id, username: e.username, name: who ? who.name : e.username, in: e.in, out: e.out, minutes: e.out ? minutesBetween(e.in, e.out) : null, by: e.by, edited: Boolean(e.edited) });

  // ---------- Time clock ----------
  async function clockFor(req, person, action, by) {
    if (!ON_SHIFT_ROLES.includes(person.role)) throw new AppError(403, "forbidden", "This role does not clock in.");
    return inTransaction(db, async (session) => {
      const open = await clock.findOne({ username: person.username, out: null }, { session });
      if (action === "in") {
        if (open) throw new AppError(409, "already_in", `${person.name || person.username} is already clocked in since ${open.in.toISOString().slice(11, 16)} UTC.`);
        const doc = { _id: `TC-${await nextSequence(db, "timeclock", 1000, session)}`, username: person.username, role: person.role, in: new Date(), out: null, by };
        try {
          await clock.insertOne(doc, { session });
        } catch (error) {
          if (error.code === 11000) throw new AppError(409, "already_in", "Already clocked in.");
          throw error;
        }
        await audit(req, "Clocked in", `${person.username}${by === "pin" ? " · PIN on a shared tablet" : ""}`, session, "info", by === "pin" ? person : null);
        return { status: "in", entry: entryView(doc, person) };
      }
      if (!open) throw new AppError(409, "not_in", `${person.name || person.username} is not clocked in.`);
      const out = new Date();
      await clock.updateOne({ _id: open._id }, { $set: { out } }, { session });
      await audit(req, "Clocked out", `${person.username} · ${Math.round(minutesBetween(open.in, out) / 6) / 10} h${by === "pin" ? " · PIN on a shared tablet" : ""}`, session, "info", by === "pin" ? person : null);
      return { status: "out", entry: entryView({ ...open, out }, person) };
    });
  }

  const clockSelf = (req, action) => clockFor(req, req.auth.user, action, "self");
  async function clockByPin(req, username, pin, action) {
    const person = await checkPin(db, req, username, pin, action === "in" ? "PIN clock-in" : "PIN clock-out");
    return clockFor(req, person, action, "pin");
  }

  // My status, this week's hours and my coming shifts
  async function me(username) {
    const week = weekOf(localDate());
    const start = dayRange(week[0]).start, end = dayRange(week[6]).end;
    const [open, entries, shifts, requests] = await Promise.all([
      clock.findOne({ username, out: null }),
      clock.find({ username, in: { $gte: start, $lt: end } }).sort({ in: 1 }).toArray(),
      rota.find({ username, date: { $gte: localDate() } }).sort({ date: 1, start: 1 }).limit(14).toArray(),
      leave.find({ username }).sort({ from: -1 }).limit(10).toArray()
    ]);
    const minutes = entries.reduce((s, e) => s + minutesBetween(e.in, e.out || new Date()), 0);
    return {
      clockedIn: open ? { since: open.in } : null, weekMinutes: minutes,
      entries: entries.map((e) => entryView(e)),
      shifts: shifts.map(shiftView), leave: requests.map(leaveView)
    };
  }

  // Who is clocked in now, for the manager's overview
  async function onShift() {
    const [open, who] = await Promise.all([clock.find({ out: null }).sort({ in: 1 }).toArray(), names()]);
    return open.map((e) => ({ username: e.username, name: (who.get(e.username) || {}).name || e.username, role: e.role, since: e.in }));
  }

  // ---------- Timesheets ----------
  async function timesheet(date) {
    const week = weekOf(date || localDate());
    const start = dayRange(week[0]).start, end = dayRange(week[6]).end;
    const [entries, who] = await Promise.all([clock.find({ in: { $gte: start, $lt: end } }).sort({ in: 1 }).toArray(), names()]);
    const people = new Map();
    for (const e of entries) {
      const row = people.get(e.username) || { username: e.username, name: (who.get(e.username) || {}).name || e.username, role: e.role, days: Object.fromEntries(week.map((d) => [d, 0])), minutes: 0, open: false, entries: [] };
      const minutes = minutesBetween(e.in, e.out || new Date());
      const day = localDate(e.in.getTime());
      if (row.days[day] !== undefined) row.days[day] += minutes;
      row.minutes += minutes;
      if (!e.out) row.open = true;
      row.entries.push(entryView(e, who.get(e.username)));
      people.set(e.username, row);
    }
    return { week, people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  // A manager corrects a forgotten clock-out or a wrong time; the old times stay in the audit log
  async function fixEntry(req, id, input) {
    return inTransaction(db, async (session) => {
      const e = await clock.findOne({ _id: id }, { session });
      if (!e) throw new AppError(404, "not_found", "Time entry not found.");
      const inAt = new Date(input.in), outAt = input.out ? new Date(input.out) : null;
      if (Number.isNaN(inAt.getTime()) || (outAt && Number.isNaN(outAt.getTime()))) throw new AppError(400, "invalid_input", "Enter valid times.");
      if (outAt && outAt <= inAt) throw new AppError(400, "invalid_input", "Clock-out must be after clock-in.");
      if (outAt && outAt - inAt > 16 * 60 * 60 * 1000) throw new AppError(400, "invalid_input", "A shift can be at most 16 hours.");
      if (inAt > new Date() || (outAt && outAt > new Date(Date.now() + 60000))) throw new AppError(400, "invalid_input", "Times cannot be in the future.");
      await clock.updateOne({ _id: id }, { $set: { in: inAt, out: outAt, edited: true, editedBy: req.auth.user.username, editReason: input.reason } }, { session });
      await audit(req, "Time entry corrected", `${id} · ${e.username} · was ${e.in.toISOString()}–${e.out ? e.out.toISOString() : "open"} · ${input.reason}`, session, "warning");
      return entryView({ ...e, in: inAt, out: outAt, edited: true });
    });
  }

  // ---------- Rota ----------
  const shiftView = (s) => ({ id: s._id, username: s.username, date: s.date, start: s.start, end: s.end, role: s.role, note: s.note || "" });
  async function rotaWeek(date) {
    const week = weekOf(date || localDate());
    const [shifts, who, away] = await Promise.all([
      rota.find({ date: { $gte: week[0], $lte: week[6] } }).sort({ date: 1, start: 1 }).toArray(),
      names(),
      leave.find({ status: "Approved", from: { $lte: week[6] }, to: { $gte: week[0] } }).toArray()
    ]);
    const staff = [...who.values()].filter((u) => ON_SHIFT_ROLES.includes(u.role)).map((u) => ({ username: u.username, name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name));
    return { week, staff, shifts: shifts.map(shiftView), leave: away.map(leaveView) };
  }

  async function addShift(req, input) {
    return inTransaction(db, async (session) => {
      const person = await users.findOne({ username: input.username, status: "Active" }, { session });
      if (!person || !ON_SHIFT_ROLES.includes(person.role)) throw new AppError(400, "invalid_input", "Choose a member of staff.");
      if (!isRealDate(input.date)) throw new AppError(400, "invalid_input", "Choose a valid date.");
      const s = toMin(input.start), e = toMin(input.end);
      if (e <= s) throw new AppError(400, "invalid_input", "The shift must end after it starts.");
      const same = await rota.find({ username: input.username, date: input.date }, { session }).toArray();
      if (same.some((x) => toMin(x.start) < e && s < toMin(x.end))) throw new AppError(409, "overlap", `${person.name} already has a shift that overlaps on ${input.date}.`);
      if (await leave.findOne({ username: input.username, status: "Approved", from: { $lte: input.date }, to: { $gte: input.date } }, { session })) throw new AppError(409, "on_leave", `${person.name} is on leave on ${input.date}.`);
      const doc = { _id: `RO-${await nextSequence(db, "rota", 1000, session)}`, username: input.username, date: input.date, start: input.start, end: input.end, role: person.role, note: input.note, by: req.auth.user.username, at: new Date() };
      await rota.insertOne(doc, { session });
      await audit(req, "Shift planned", `${doc._id} · ${input.username} · ${input.date} ${input.start}–${input.end}`, session);
      return shiftView(doc);
    });
  }

  async function removeShift(req, id) {
    return inTransaction(db, async (session) => {
      const s = await rota.findOneAndDelete({ _id: id }, { session });
      if (!s) throw new AppError(404, "not_found", "Shift not found.");
      await audit(req, "Shift removed", `${id} · ${s.username} · ${s.date} ${s.start}–${s.end}`, session);
    });
  }

  // ---------- Leave ----------
  const leaveView = (l) => ({ id: l._id, username: l.username, from: l.from, to: l.to, reason: l.reason, status: l.status, decidedBy: l.decidedBy || null, createdAt: l.createdAt });
  async function requestLeave(req, input) {
    if (!isRealDate(input.from) || !isRealDate(input.to) || input.to < input.from) throw new AppError(400, "invalid_input", "The last day must be on or after the first day.");
    if (input.from < localDate()) throw new AppError(400, "invalid_input", "Leave cannot start in the past.");
    if ((Date.parse(input.to) - Date.parse(input.from)) / DAY > 30) throw new AppError(400, "invalid_input", "Ask for at most 31 days at a time.");
    return inTransaction(db, async (session) => {
      const doc = { _id: `LV-${await nextSequence(db, "leave", 100, session)}`, username: req.auth.user.username, from: input.from, to: input.to, reason: input.reason, status: "Pending", createdAt: new Date() };
      await leave.insertOne(doc, { session });
      await audit(req, "Leave requested", `${doc._id} · ${input.from} to ${input.to}`, session);
      return leaveView(doc);
    });
  }
  async function listLeave() {
    const [rows, who] = await Promise.all([leave.find({ $or: [{ status: "Pending" }, { to: { $gte: localDate(Date.now() - 30 * DAY) } }] }).sort({ from: 1 }).limit(200).toArray(), names()]);
    return rows.map((l) => ({ ...leaveView(l), name: (who.get(l.username) || {}).name || l.username }));
  }
  // Approving shows which planned shifts clash, so the manager can cover them
  async function decideLeave(req, id, approve) {
    return inTransaction(db, async (session) => {
      const l = await leave.findOne({ _id: id }, { session });
      if (!l) throw new AppError(404, "not_found", "Leave request not found.");
      if (l.username === req.auth.user.username) throw new AppError(403, "own_request", "Someone else must decide your own leave.");
      const updated = await leave.findOneAndUpdate({ _id: id, status: "Pending" }, { $set: { status: approve ? "Approved" : "Rejected", decidedBy: req.auth.user.username, decidedAt: new Date() } }, { returnDocument: "after", session });
      if (!updated) throw new AppError(409, "bad_status", "This request has already been decided.");
      await audit(req, approve ? "Leave approved" : "Leave rejected", `${id} · ${l.username} · ${l.from} to ${l.to}`, session);
      const clashes = approve ? (await rota.find({ username: l.username, date: { $gte: l.from, $lte: l.to } }, { session }).toArray()).map(shiftView) : [];
      return { ...leaveView(updated), clashes };
    });
  }

  // ---------- Tips ----------
  // The day's tips are shared by the hours each person worked that day
  async function tipsShare(date) {
    const day = date || localDate();
    const range = dayRange(day);
    const [paid, entries, who] = await Promise.all([
      bills.find({ createdAt: { $gte: range.start, $lt: range.end }, status: "Paid", tip: { $gt: 0 } }, { projection: { tip: 1 } }).toArray(),
      clock.find({ in: { $lt: range.end }, $or: [{ out: null }, { out: { $gt: range.start } }] }).toArray(),
      names()
    ]);
    const total = paid.reduce((s, b) => s + b.tip, 0);
    const hours = new Map();
    for (const e of entries) {
      // Only the part of each shift that fell on this day counts
      const from = e.in < range.start ? range.start : e.in;
      const to = !e.out || e.out > range.end ? (e.out ? range.end : new Date(Math.min(Date.now(), range.end.getTime()))) : e.out;
      hours.set(e.username, (hours.get(e.username) || 0) + minutesBetween(from, to));
    }
    const totalMinutes = [...hours.values()].reduce((s, m) => s + m, 0);
    let given = 0;
    const people = [...hours.entries()].sort((a, b) => b[1] - a[1]).map(([username, minutes], i, all) => {
      // Whole rupees; the last person gets what rounding leaves, so the shares add up exactly
      const share = i === all.length - 1 ? total - given : Math.floor((total * minutes) / (totalMinutes || 1));
      given += share;
      return { username, name: (who.get(username) || {}).name || username, minutes, share };
    });
    return { date: day, total, minutes: totalMinutes, people };
  }

  return { clockSelf, clockByPin, me, onShift, timesheet, fixEntry, rotaWeek, addShift, removeShift, requestLeave, listLeave, decideLeave, tipsShare, weekOf };
}

module.exports = { createPeopleService, weekOf };
