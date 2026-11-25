// Phase 7 (People): clocking in and out (yourself, or with a PIN on a shared tablet), weekly
// timesheets with manager corrections and a CSV, the rota, leave requests and the tips share.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, PASSWORD } = require("./helpers");
const { localDate } = require("../server/lib/domain");
const { weekOf } = require("../server/services/people");

const API = "/api/v1";
let ctx, db, app, config, admin, waiter, waiter2, kitchen, cashier, manager, manager2;
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const plusDays = (n) => localDate(Date.now() + n * 24 * 60 * 60 * 1000);

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  [admin, waiter, waiter2, kitchen, cashier, manager, manager2] = await Promise.all(["Admin", "Waiter", "Waiter", "Kitchen", "Cashier", "Manager", "Manager"].map(as));
});
after(() => ctx.stop());

describe("time clock", () => {
  test("staff clock themselves in and out, once at a time", async () => {
    const inRes = await waiter.post(`${API}/timeclock`, { action: "in" });
    assert.equal(inRes.status, 200, JSON.stringify(inRes.body));
    assert.equal((await waiter.post(`${API}/timeclock`, { action: "in" })).body.error.code, "already_in");
    const me = (await waiter.get(`${API}/timeclock/me`)).body;
    assert.ok(me.clockedIn);
    assert.ok((await manager.get(`${API}/timeclock/now`)).body.people.some((p) => p.username === waiter.user.username));
    assert.equal((await waiter.post(`${API}/timeclock`, { action: "out" })).body.status, "out");
    assert.equal((await waiter.post(`${API}/timeclock`, { action: "out" })).body.error.code, "not_in");
    assert.equal((await admin.post(`${API}/timeclock`, { action: "in" })).status, 403, "Admins do not clock in");
  });

  test("on a shared tablet, a person clocks in with their PIN; wrong PINs are counted and paused", async () => {
    assert.equal((await kitchen.put(`${API}/auth/pin`, { currentPassword: PASSWORD, pin: "5829" })).status, 204);
    const tablet = waiter;
    const res = await tablet.post(`${API}/timeclock/pin`, { username: kitchen.user.username, pin: "5829", action: "in" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = await db.collection("timeclock").findOne({ username: kitchen.user.username, out: null });
    assert.equal(entry.by, "pin");
    assert.ok(await db.collection("audit_events").findOne({ action: "Clocked in", actor: kitchen.user.username }));
    for (let i = 0; i < 5; i++) assert.equal((await tablet.post(`${API}/timeclock/pin`, { username: kitchen.user.username, pin: "0000", action: "out" })).status, 401);
    assert.equal((await tablet.post(`${API}/timeclock/pin`, { username: kitchen.user.username, pin: "5829", action: "out" })).status, 401, "paused after 5 wrong PINs");
    assert.ok(await db.collection("audit_events").findOne({ action: "PIN clock-out failed" }));
    // A manager (no PIN) cannot be clocked in this way
    assert.equal((await tablet.post(`${API}/timeclock/pin`, { username: manager.user.username, pin: "5829", action: "in" })).status, 401);
  });
});

describe("timesheets", () => {
  test("hours are added up per person per day; a manager corrects an entry, which is audited", async () => {
    const now = Date.now();
    const id = "TC-990001";
    await db.collection("timeclock").insertOne({ _id: id, username: cashier.user.username, role: "Cashier", in: new Date(now - 5 * 60 * 60 * 1000), out: new Date(now - 60 * 60 * 1000), by: "self" });
    const sheet = (await manager.get(`${API}/timesheets`)).body;
    const row = sheet.people.find((p) => p.username === cashier.user.username);
    assert.equal(row.minutes, 240);
    assert.equal(sheet.week.length, 7);

    const fixed = await manager.put(`${API}/timeclock/${id}`, { in: new Date(now - 6 * 60 * 60 * 1000).toISOString(), out: new Date(now - 60 * 60 * 1000).toISOString(), reason: "Forgot to clock in" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.minutes, 300);
    assert.ok(await db.collection("audit_events").findOne({ action: "Time entry corrected", details: { $regex: id } }));
    assert.equal((await manager.put(`${API}/timeclock/${id}`, { in: new Date(now).toISOString(), out: new Date(now - 1000).toISOString(), reason: "Bad times" })).status, 400);
    assert.equal((await waiter.put(`${API}/timeclock/${id}`, { in: new Date(now).toISOString(), reason: "Mine now" })).status, 403);
    assert.equal((await waiter.get(`${API}/timesheets`)).status, 403);
  });

  test("the timesheet downloads as a CSV for payroll", async () => {
    const res = await manager.get(`${API}/timesheets.csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/csv/);
    assert.match(res.text, /Total hours/);
    assert.match(res.text, /5\.00/);
  });

  test("a week runs Monday to Sunday", () => {
    assert.deepEqual(weekOf("2026-11-25"), ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
    assert.equal(weekOf("2026-11-29")[0], "2026-11-23");
  });
});

describe("rota and leave", () => {
  test("a manager plans shifts that everyone can see; overlaps are refused", async () => {
    const day = plusDays(2);
    const res = await manager.post(`${API}/rota`, { username: waiter.user.username, date: day, start: "09:00", end: "17:00" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await manager.post(`${API}/rota`, { username: waiter.user.username, date: day, start: "16:00", end: "20:00" })).body.error.code, "overlap");
    assert.equal((await manager.post(`${API}/rota`, { username: waiter.user.username, date: day, start: "18:00", end: "17:00" })).status, 400);
    assert.equal((await manager.post(`${API}/rota`, { username: admin.user.username, date: day, start: "09:00", end: "17:00" })).status, 400, "Admins are not on the rota");
    const seen = (await kitchen.get(`${API}/rota?week=${day}`)).body;
    assert.ok(seen.shifts.some((s) => s.id === res.body.id));
    assert.equal((await kitchen.post(`${API}/rota`, { username: kitchen.user.username, date: day, start: "09:00", end: "10:00" })).status, 403);
    assert.ok((await waiter.get(`${API}/timeclock/me`)).body.shifts.some((s) => s.id === res.body.id));
  });

  test("leave is requested, decided by someone else, and shows the shifts that need cover", async () => {
    const day = plusDays(2);
    const asked = await waiter.post(`${API}/leave`, { from: day, to: day, reason: "Family wedding" });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    assert.equal((await waiter.post(`${API}/leave`, { from: plusDays(-3), to: plusDays(-2), reason: "Too late" })).status, 400);
    const approved = await manager.post(`${API}/leave/${asked.body.id}/approve`, {});
    assert.equal(approved.status, 200);
    assert.equal(approved.body.clashes.length, 1, "the planned shift on that day needs cover");
    assert.equal((await manager.post(`${API}/leave/${asked.body.id}/reject`, {})).status, 409, "decided once");
    assert.equal((await manager.post(`${API}/rota`, { username: waiter.user.username, date: day, start: "18:00", end: "22:00" })).body.error.code, "on_leave");
    const mine = await manager.post(`${API}/leave`, { from: plusDays(5), to: plusDays(6), reason: "Rest days" });
    assert.equal((await manager.post(`${API}/leave/${mine.body.id}/approve`, {})).body.error.code, "own_request");
    assert.equal((await manager2.post(`${API}/leave/${mine.body.id}/approve`, {})).status, 200);
  });
});

describe("tips share", () => {
  test("the day's tips are shared by hours worked, and add up exactly", async () => {
    const today = localDate();
    await db.collection("timeclock").deleteMany({});
    const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await db.collection("timeclock").insertMany([
      { _id: "TC-1", username: waiter.user.username, role: "Waiter", in: start, out: new Date(start.getTime() + 2 * 60 * 60 * 1000), by: "self" },
      { _id: "TC-2", username: waiter2.user.username, role: "Waiter", in: start, out: new Date(start.getTime() + 60 * 60 * 1000), by: "self" }
    ]);
    await db.collection("bills").insertMany([
      { _id: "B-TIP1", status: "Paid", tip: 200, total: 1000, createdAt: new Date(), lines: [], method: "Card" },
      { _id: "B-TIP2", status: "Paid", tip: 101, total: 1000, createdAt: new Date(), lines: [], method: "Card" }
    ]);
    const tips = (await manager.get(`${API}/tips?date=${today}`)).body;
    assert.equal(tips.total, 301);
    const share = Object.fromEntries(tips.people.map((p) => [p.username, p.share]));
    assert.equal(share[waiter.user.username], 200);
    assert.equal(share[waiter2.user.username], 101);
    assert.equal(tips.people.reduce((s, p) => s + p.share, 0), 301);
    assert.equal((await cashier.get(`${API}/tips`)).status, 403);
  });
});
