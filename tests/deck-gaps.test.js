// One test for each gap found by re-reading the lecture decks against the finished code.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { startDb, buildApp, browser, createUser, signIn, freshCode, ORIGIN } = require("./helpers");
const { createAlertService } = require("../server/services/alerts");
const { recordEvent } = require("../server/services/auditLog");
const { watchSecuritySettings, recordBackupSuccess, checkBackupAge, checkLogReview } = require("../server/services/opsChecks");
const { createBackup } = require("../server/lib/backup");
const { limited, MAX_RUNNING, MAX_WAITING } = require("../server/lib/passwords");
const { seedCatalog } = require("../scripts/seed-data");
const request = require("supertest");

const API = "/api/v1";
let ctx, db, app, config, alerts;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  alerts = createAlertService({ db });
});
after(() => ctx.stop());

const as = async (role) => {
  const user = await createUser(db, config, { role });
  const client = await signIn(app, db, user);
  client.user = user;
  return client;
};
const clearAlerts = () => db.collection("alerts").deleteMany({});
const events = (action, actor) => db.collection("audit_events").countDocuments({ action, ...(actor ? { actor } : {}) });

describe("alerts cannot be buried (Failures, slide 13)", () => {
  test("a flood of low-value alerts cannot push a serious one out of the Admin's list", async () => {
    await clearAlerts();
    for (let i = 0; i < 4; i++) await recordEvent(db, null, { actor: "insider.user", action: "Report exported", details: "Sales CSV", severity: "warning" });
    for (let n = 0; n < 60; n++) {
      await db.collection("alerts").insertOne({ _id: `flood-${n}`, key: `failed-sign-ins-address:${n}`, rule: "failed-sign-ins-address", status: "Open", severity: "high", title: "Flood", details: "x", lastSeenAt: new Date(Date.now() + 60000), createdAt: new Date(), count: 10 });
    }
    await alerts.evaluate();
    const shown = await alerts.listOpen();
    assert.ok(shown.some((a) => a.rule === "bulk-export"), "the insider's export is still listed");
    const flood = shown.filter((a) => a.rule === "failed-sign-ins-address");
    assert.equal(flood.length, 5);
    assert.equal(flood[0].similarHidden, (await db.collection("alerts").countDocuments({ rule: "failed-sign-ins-address", status: "Open" })) - 5, "the list says how many are folded away");
    await clearAlerts();
  });

  test("the most serious alerts are listed first", async () => {
    await clearAlerts();
    await alerts.raise({ key: "a", rule: "account-locked", title: "Minor", details: "x", severity: "warning" });
    await alerts.raise({ key: "b", rule: "payment-conflict", title: "Serious", details: "x", severity: "high" });
    await alerts.raise({ key: "c", rule: "new-network", title: "Latest minor", details: "x", severity: "warning" });
    assert.equal((await alerts.listOpen())[0].rule, "payment-conflict");
    await clearAlerts();
  });
});

describe("configuration and permission changes raise alerts (Failures, slide 16)", () => {
  test("a role change raises an alert", async () => {
    await clearAlerts();
    const admin = await as("Admin");
    const staff = await createUser(db, config, { role: "Waiter" });
    assert.equal((await admin.post(`${API}/auth/step-up`, { code: await freshCode(db, admin.user) })).status, 204);
    const res = await admin.post(`${API}/users/${staff.username}/role`, { role: "Cashier" });
    assert.ok([200, 201].includes(res.status), res.text);
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "access-changed", status: "Open" }));
    await clearAlerts();
  });

  test("many price changes by one person raise an alert", async () => {
    await clearAlerts();
    for (let i = 0; i < 5; i++) await recordEvent(db, null, { actor: "price.changer", action: "Price changed", details: "x", severity: "warning" });
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "price-changes", status: "Open" }));
    await clearAlerts();
  });

  test("a changed security setting is recorded by name and raises an alert", async () => {
    await clearAlerts();
    await db.collection("system_status").deleteMany({ _id: "security-settings" });
    assert.deepEqual(await watchSecuritySettings({ config, db }), []);
    assert.deepEqual(await watchSecuritySettings({ config, db }), []);
    const weaker = { ...config, auth: { ...config.auth, maxFailedAttempts: 50 } };
    assert.deepEqual(await watchSecuritySettings({ config: weaker, db }), ["auth_maxFailedAttempts"]);
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "security-settings", status: "Open" }));
    const stored = JSON.stringify(await db.collection("system_status").findOne({ _id: "security-settings" }));
    assert.ok(!stored.includes(config.blindIndexKey.toString("base64")), "keys are never stored");
    await clearAlerts();
  });
});

describe("stopped backups are noticed (Attackers, slide 12)", () => {
  const live = () => ({ ...config, backupMaxAgeHours: 26 });
  const later = (hours) => Date.now() + hours * 3600000;

  test("no recent backup raises an alert, and a recent one does not", async () => {
    await clearAlerts();
    await db.collection("system_status").deleteMany({});
    await watchSecuritySettings({ config, db });
    assert.equal(await checkBackupAge({ config: live(), db, alerts }), false, "a new deployment has a day to take its first backup");
    assert.equal(await checkBackupAge({ config: live(), db, alerts, now: later(30) }), true, "a deployment that never backs up is caught");
    await clearAlerts();

    await recordBackupSuccess(db, "abc");
    assert.equal(await checkBackupAge({ config: live(), db, alerts, now: later(25) }), false);
    assert.equal(await checkBackupAge({ config: live(), db, alerts, now: later(30) }), true);
    assert.ok(await db.collection("alerts").findOne({ rule: "backup-stale", status: "Open" }));
    await clearAlerts();
  });

  test("the check is off where no backups are expected", async () => {
    assert.equal(await checkBackupAge({ config: { ...config, backupMaxAgeHours: 0 }, db, alerts, now: later(900) }), false);
  });

  test("the status record stays out of backups, so a restore still starts from an empty database", async () => {
    await recordBackupSuccess(db, "abc");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "cafems-status-"));
    const key = require("crypto").randomBytes(32);
    const made = await createBackup({ db, key, directory: dir, uploadDir: config.uploadDir });
    assert.ok(!Object.hasOwn(made.counts || {}, "system_status"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the audit log is reviewed regularly (Week 2, scenario 14)", () => {
  const live = () => ({ ...config, logReviewDays: 7 });
  const later = (days) => Date.now() + days * 86400000;

  test("an overdue review raises a reminder, and recording a review clears it", async () => {
    await clearAlerts();
    await db.collection("system_status").deleteMany({ _id: "security-settings" });
    await watchSecuritySettings({ config, db });
    assert.equal(await checkLogReview({ config: live(), db, alerts }), false);
    assert.equal(await checkLogReview({ config: live(), db, alerts, now: later(9) }), true);
    assert.ok(await db.collection("alerts").findOne({ rule: "log-review-due", status: "Open" }));
    await clearAlerts();

    const admin = await as("Admin");
    assert.equal((await admin.post(`${API}/audit/review`, { note: "Checked this week's entries" })).status, 204);
    assert.equal(await events("Audit log reviewed", admin.user.username), 1);
    assert.equal(await checkLogReview({ config: live(), db, alerts, now: later(6) }), false);
    assert.equal(await checkLogReview({ config: live(), db, alerts, now: later(9) }), true);
    await clearAlerts();
  });

  test("a review must say something, and only an Admin can record one", async () => {
    const admin = await as("Admin");
    assert.equal((await admin.post(`${API}/audit/review`, { note: "" })).status, 400);
    assert.equal((await admin.post(`${API}/audit/review`, { note: "<script>alert(1)</script>" })).status, 400);
    assert.equal((await (await as("Waiter")).post(`${API}/audit/review`, { note: "Reviewed it" })).status, 403);
  });
});

describe("least privilege for the kitchen", () => {
  test("the kitchen's data holds no prices or phone numbers of any kind", async () => {
    await db.collection("settings").updateOne({ _id: "cafe" }, { $set: { name: "Test Cafe", phone: "03001234567" } }, { upsert: true });
    const res = await (await as("Kitchen")).get(`${API}/snapshot`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /price|phone/i);
    assert.equal(res.body.cafe.name, "Test Cafe");
  });
});

describe("sign-in from a new country (Week 2, scenario 7)", () => {
  const { countryOf } = require("../server/lib/geo");
  const { createApp } = require("../server/app");
  const { createLogger } = require("../server/lib/logger");

  test("addresses are placed in countries locally, and private addresses in none", () => {
    assert.equal(countryOf("39.32.0.1"), "PK");
    assert.equal(countryOf("1.0.16.1"), "JP");
    assert.equal(countryOf("::ffff:1.0.4.5"), "AU");
    assert.equal(countryOf("2001:200::1"), "JP");
    for (const ip of ["10.0.0.1", "127.0.0.1", "::1", "", "not an address"]) assert.equal(countryOf(ip), null, ip);
  });

  test("the first country is learned quietly, and a sign-in from a new one raises a high alert", async () => {
    await clearAlerts();
    const proxied = createApp({ config: { ...config, trustProxy: 1 }, db, logger: createLogger(config) });
    const user = await createUser(db, config, { role: "Waiter" });
    const from = async (ip) => {
      const c = browser(proxied);
      const headers = { "X-Forwarded-For": ip };
      assert.equal((await c.post(`${API}/auth/login`, { username: user.username, password: user.password }, { headers })).status, 200);
      assert.equal((await c.post(`${API}/auth/mfa/verify`, { code: await freshCode(db, user) }, { headers })).status, 200);
    };
    await from("39.32.0.1");
    assert.equal(await events("Sign-in from a new country", user.username), 0);
    await from("39.32.5.9");
    assert.equal(await events("Sign-in from a new country", user.username), 0, "same country again");
    await from("1.0.16.1");
    const entry = await db.collection("audit_events").findOne({ actor: user.username, action: "Sign-in from a new country" });
    assert.match(entry.details, /^JP/);
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "new-country", status: "Open", severity: "high" }));
    await clearAlerts();
  });
});

describe("sign-in from an unusual place (Week 2 scenario 7, Week 4 slide 26)", () => {
  test("a new network raises an alert; a known one, and a person's first sign-in, do not", async () => {
    await clearAlerts();
    const user = await createUser(db, config, { role: "Waiter" });
    await signIn(app, db, user);
    assert.equal(await events("Sign-in from a new network", user.username), 0, "the first network is learned quietly");
    await signIn(app, db, user);
    assert.equal(await events("Sign-in from a new network", user.username), 0, "a known network is quiet");

    await db.collection("users").updateOne({ username: user.username }, { $set: { knownNetworks: ["elsewhere"] } });
    await signIn(app, db, user);
    assert.equal(await events("Sign-in from a new network", user.username), 1);
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "new-network", status: "Open" }));
    const stored = await db.collection("users").findOne({ username: user.username });
    assert.ok(stored.knownNetworks.every((n) => !/[.:]/.test(n)), "networks are kept only as keyed references");
    await clearAlerts();
  });
});

describe("access to customer records is logged (Week 2 scenario 14, FMEA slide 15)", () => {
  test("opening reservations is recorded once an hour per person, without repeating on every refresh", async () => {
    const waiter = await as("Waiter");
    const count = () => events("Customer records viewed", waiter.user.username);
    assert.equal(await count(), 0);
    await waiter.get(`${API}/snapshot`);
    assert.equal(await count(), 1);
    await waiter.get(`${API}/snapshot`);
    await waiter.get(`${API}/reservations`);
    assert.ok(await count() <= 2, "repeat refreshes are not recorded again");
  });

  test("opening one bill is recorded, and many views raise an alert", async () => {
    await clearAlerts();
    const manager = await as("Manager");
    await db.collection("bills").insertOne({ _id: "B-91001", table: 1, orderIds: [], lines: [], discountPct: 0, subtotal: 100, discount: 0, tax: 16, total: 116, method: "Cash", tendered: 116, change: 0, cashier: "c", createdAt: new Date(), status: "Paid" });
    assert.equal((await manager.get(`${API}/bills/B-91001`)).status, 200);
    assert.equal(await events("Bill viewed", manager.user.username), 1);
    for (let i = 0; i < 40; i++) await recordEvent(db, null, { actor: "record.reader", action: "Bill viewed", details: `B-${i}`, severity: "info" });
    await alerts.evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "record-views", status: "Open" }));
    await clearAlerts();
  });
});

describe("uploaded photos are rebuilt (SSD Lec1, slides 3 and 8)", () => {
  const upload = (client, id, type, body) => {
    const cookie = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    return client.loadCsrf().then((me) => request(app).put(`${API}/menu/${id}/photo`).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", me.body.csrfToken).set("Content-Type", type).send(body));
  };
  const pixels = { create: { width: 32, height: 32, channels: 3, background: "#884400" } };

  test("content hidden after a real image, and its metadata, do not survive", async () => {
    const admin = await as("Admin");
    const jpeg = await sharp(pixels).withExif({ IFD0: { Copyright: "SECRET-METADATA" } }).jpeg().toBuffer();
    const payload = Buffer.from("<script>alert('HIDDEN-PAYLOAD')</script>");
    assert.equal((await upload(admin, 4, "image/jpeg", Buffer.concat([jpeg, payload]))).status, 204);
    const item = await db.collection("menu").findOne({ _id: 4 });
    const stored = fs.readFileSync(path.join(config.uploadDir, item.photo.file));
    assert.equal((await sharp(stored).metadata()).format, "jpeg");
    assert.ok(!stored.includes("HIDDEN-PAYLOAD"));
    assert.ok(!stored.includes("SECRET-METADATA"));
  });

  test("a file with an image header that is not really an image is refused and recorded", async () => {
    const admin = await as("Admin");
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not an image at all, just text padding")]);
    const before = await events("Upload refused");
    assert.equal((await upload(admin, 4, "image/png", fake)).status, 415);
    assert.equal(await events("Upload refused"), before + 1);
  });

  test("an image claiming to be another format is refused", async () => {
    const admin = await as("Admin");
    const webp = await sharp(pixels).webp().toBuffer();
    const disguised = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), webp]);
    assert.equal((await upload(admin, 4, "image/jpeg", disguised)).status, 415);
  });
});

describe("a sign-in flood cannot exhaust memory (Week 4, slide 8)", () => {
  const held = () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    return { gate, release };
  };

  test("only a few passwords are hashed at once, and an overfull queue is refused", async () => {
    const { gate, release } = held();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
    };
    const accepted = Array.from({ length: MAX_RUNNING + MAX_WAITING }, () => limited(task));
    await assert.rejects(limited(task), (error) => error.status === 503);
    release();
    await Promise.all(accepted);
    assert.equal(peak, MAX_RUNNING);
  });
});
