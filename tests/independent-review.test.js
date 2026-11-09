// One test for each defect found by the independent review of the finished system.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startDb, buildApp, browser, createUser, freshCode, signIn } = require("./helpers");
const { recordEvent, verifyChain } = require("../server/services/auditLog");
const { createAlertService } = require("../server/services/alerts");
const { createBackup, restoreBackup, pruneBackups } = require("../server/lib/backup");
const { callbackSignature } = require("../server/services/gateway");
const { ensureAppRole } = require("../server/lib/dbRoles");
const { edges } = require("../server/lib/dependencies");
const { seedCatalog } = require("../scripts/seed-data");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role, target = { app, config }) {
  const user = await createUser(db, target.config, { role });
  const client = await signIn(target.app, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}
let counter = 7000;
async function insertBill(extra = {}) {
  counter += 1;
  const bill = {
    _id: `B-${counter}`, table: 1, orderIds: [], lines: [], discountPct: 0, subtotal: 100, discount: 0, tax: 16, total: 116,
    method: "Cash", tendered: 116, change: 0, cashier: "someone", createdAt: new Date(), status: "Paid", ...extra
  };
  await db.collection("bills").insertOne(bill);
  return bill;
}

describe("Admins can contain each other", () => {
  test("one Admin can disable a compromised Admin at once, and it raises an alert", async () => {
    const [a, target] = [await as("Admin"), await as("Admin")];
    await stepUp(a);
    const res = await a.post(`${API}/users/${target.user.username}/status`, { status: "Disabled" });
    assert.equal(res.status, 200);
    assert.equal((await db.collection("users").findOne({ username: target.user.username })).status, "Disabled");
    assert.equal((await target.get(`${API}/auth/me`)).status, 401);
    await createAlertService({ db }).evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "admin-disabled", status: "Open" }));
  });
});

describe("the second person must really be someone else", () => {
  test("the Admin who set up a Manager's account cannot approve that Manager's large refund", async () => {
    const [sponsor, other, manager] = [await as("Admin"), await as("Admin"), await as("Manager")];
    await db.collection("users").updateOne({ username: manager.user.username }, { $set: { sponsor: sponsor.user.username } });
    const bill = await insertBill({ total: 9280, subtotal: 8000, tax: 1280 });
    await stepUp(manager);
    const { approvalId } = (await manager.post(`${API}/bills/${bill._id}/refund`, { reason: "Party cancelled" }, key())).body;
    await stepUp(sponsor);
    assert.equal((await sponsor.post(`${API}/approvals/${approvalId}/approve`, {})).body.error.code, "same_person");
    assert.equal((await db.collection("bills").findOne({ _id: bill._id })).status, "Paid");
    await stepUp(other);
    assert.equal((await other.post(`${API}/approvals/${approvalId}/approve`, {})).body.status, "Refunded");
  });

  test("inviting or resetting someone records who set up their account", async () => {
    const admin = await as("Admin");
    await stepUp(admin);
    await admin.post(`${API}/users/invitations`, { username: "new.manager", name: "New Manager", role: "Manager" });
    assert.equal((await db.collection("users").findOne({ username: "new.manager" })).sponsor, admin.user.username);
  });
});

describe("audit log integrity", () => {
  test("a row added outside the chain fails verification and is never shown", async () => {
    const admin = await as("Admin");
    await db.collection("audit_events").insertOne({ actor: "forged.row", action: "Refund issued", details: "x", severity: "high", at: new Date() });
    try {
      const result = await verifyChain(db);
      assert.equal(result.ok, false);
      assert.match(result.reason, /not part of the chain/);
      const listed = (await admin.get(`${API}/audit`)).body.entries;
      assert.ok(!listed.some((e) => e.actor === "forged.row"));
    } finally {
      await db.collection("audit_events").deleteOne({ actor: "forged.row" });
    }
  });

  test("a row placed beyond the end of the chain fails verification", async () => {
    await recordEvent(db, null, { actor: "system", action: "Marker", details: "" });
    const head = await db.collection("audit_head").findOne({ _id: "head" });
    await db.collection("audit_events").insertOne({ seq: head.seq + 500, actor: "forged.tail", action: "x", at: new Date() });
    try {
      assert.match((await verifyChain(db)).reason, /beyond the end/);
    } finally {
      await db.collection("audit_events").deleteOne({ actor: "forged.tail" });
    }
  });

  test("verifying while actions are being written gives no false alarm", async () => {
    let stop = false;
    const writer = (async () => { while (!stop) await recordEvent(db, null, { actor: "system", action: "Busy", details: "" }); })();
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await verifyChain(db));
    stop = true;
    await writer;
    assert.deepEqual(results.filter((r) => !r.ok), []);
  });

  test("the app's database account cannot add indexes to the audit log, so it cannot erase it with a TTL index", async () => {
    await ensureAppRole(db);
    const { roles } = await db.command({ rolesInfo: "cafemsApp", showPrivileges: true });
    const privilege = roles[0].privileges.find((p) => p.resource.collection === "audit_events");
    assert.deepEqual([...privilege.actions].sort(), ["find", "insert", "listIndexes"]);
  });

  test("an unknown username is never stored, in case a password was typed there", async () => {
    await browser(app).post(`${API}/auth/login`, { username: "hunter2-secret-pw!", password: "Wrong-Password-1" });
    assert.equal(await db.collection("audit_events").countDocuments({ $or: [{ actor: /hunter2/ }, { details: /hunter2/ }] }), 0);
    assert.ok(await db.collection("audit_events").findOne({ actor: "unknown", details: /ref [0-9a-f]{12}/ }));
  });
});

describe("backups", () => {
  test("a backup taken while the cafe is busy restores with a valid audit chain", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-live-backup-"));
    const backupKey = crypto.randomBytes(32);
    let stop = false;
    const writer = (async () => { while (!stop) await recordEvent(db, null, { actor: "system", action: "Busy", details: "" }); })();
    const backups = [];
    for (let i = 0; i < 4; i++) backups.push(await createBackup({ db, key: backupKey, directory }));
    stop = true;
    await writer;
    for (const [i, backup] of backups.entries()) {
      const target = db.client.db(`cafems_live_restore_${i}`);
      await restoreBackup({ backupPath: backup.path, key: backupKey, db: target });
      const { bindAudit } = require("../server/services/auditLog");
      bindAudit(target, config);
      assert.equal((await verifyChain(target)).ok, true, `restore ${i}`);
    }
  });

  test("old backups are removed, and only files this tool made", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-prune-"));
    const write = (name, days) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, "x");
      const at = new Date(Date.now() - days * 86400000);
      fs.utimesSync(file, at, at);
    };
    write("cafems-2026-01-01T00-00-00-000Z.bak", 40);
    write("cafems-2026-01-01T00-00-00-000Z.bak.manifest.json", 40);
    write("cafems-2026-11-01T00-00-00-000Z.bak", 5);
    write("my-notes.txt", 400);
    assert.equal((await pruneBackups(directory, 30)).length, 2);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["cafems-2026-11-01T00-00-00-000Z.bak", "my-notes.txt"]);
  });
});

describe("customer numbers", () => {
  test("searching by number is limited per person and recorded, without storing the number", async () => {
    const built = buildApp(db);
    const waiter = await as("Waiter", built);
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await waiter.post(`${API}/reservations/search`, { phone: `030012345${String(i).padStart(2, "0")}` })).status);
    assert.equal(codes.filter((c) => c === 200).length, 30);
    assert.equal(codes.at(-1), 429);
    const rows = await db.collection("audit_events").find({ actor: waiter.user.username, action: "Customer number searched" }).toArray();
    assert.equal(rows.length, 30);
    assert.ok(!rows.some((r) => /0300/.test(r.details)));
  });
});

describe("locked accounts", () => {
  test("a locked account cannot pass an authenticator re-check or change its password", async () => {
    const waiter = await as("Waiter");
    await db.collection("users").updateOne({ username: waiter.user.username }, { $set: { lockedUntil: new Date(Date.now() + 600000) } });
    assert.equal((await waiter.post(`${API}/auth/step-up`, { code: await freshCode(db, waiter.user) })).status, 401);
    assert.equal((await waiter.post(`${API}/auth/password`, { currentPassword: waiter.user.password, newPassword: "Fresh-Kettle-99-River" })).status, 401);
  });
});

describe("errors and limits", () => {
  test("an unsupported charset is a client error, not a server error", async () => {
    const res = await browser(app).post(`${API}/auth/login`, undefined, { headers: { "Content-Type": "application/json; charset=foo" } });
    assert.equal(res.status, 415);
  });

  test("the export limit is shared by every export, per person", async () => {
    const built = buildApp(db);
    const admin = await as("Admin", built);
    for (let i = 0; i < 10; i++) assert.equal((await admin.get(`${API}/audit.csv`)).status, 200);
    assert.equal((await admin.get(`${API}/risk.csv`)).status, 429);
  });
});

describe("refunds", () => {
  test("a bill older than the refund window cannot be refunded", async () => {
    const bill = await insertBill({ createdAt: new Date(Date.now() - 31 * 86400000) });
    const manager = await as("Manager");
    await stepUp(manager);
    assert.equal((await manager.post(`${API}/bills/${bill._id}/refund`, { reason: "Too late now" }, key())).body.error.code, "refund_window");
  });

  test("a card refund reaches the gateway once; a cash refund does not", async () => {
    const calls = [];
    const gateway = { charge: async () => ({}), refund: async ({ reference }) => { calls.push(reference); return { gatewayRef: "R-1" }; } };
    const built = buildApp(db, {}, gateway);
    const manager = await as("Manager", built);
    await stepUp(manager);
    const card = await insertBill({ method: "Card", gatewayRef: "G-1" });
    const cash = await insertBill();
    const headers = key();
    await manager.post(`${API}/bills/${card._id}/refund`, { reason: "Wrong item" }, headers);
    await manager.post(`${API}/bills/${card._id}/refund`, { reason: "Wrong item" }, headers);
    await manager.post(`${API}/bills/${cash._id}/refund`, { reason: "Wrong item" }, key());
    assert.deepEqual(calls, [card._id]);
    assert.ok((await db.collection("bills").findOne({ _id: card._id })).refund.reversedAt);
  });

  test("if the gateway cannot return the money, a person is alerted", async () => {
    const gateway = { charge: async () => ({}), refund: async () => { throw new Error("down"); } };
    const built = buildApp(db, {}, gateway);
    const manager = await as("Manager", built);
    await stepUp(manager);
    const card = await insertBill({ method: "Wallet", gatewayRef: "G-2" });
    assert.equal((await manager.post(`${API}/bills/${card._id}/refund`, { reason: "Wrong item" }, key())).body.status, "Refunded");
    await createAlertService({ db }).evaluate();
    assert.ok(await db.collection("alerts").findOne({ rule: "refund-reversal", status: "Open" }));
  });
});

describe("payment callback", () => {
  test("a callback that failed part-way can be retried; only a processed one is a replay", async () => {
    const reference = "B-7999";
    const body = { reference, amount: 116, status: "approved", gatewayRef: "RETRY-1" };
    const timestamp = String(Date.now());
    const headers = { "x-gateway-timestamp": timestamp, "x-gateway-signature": callbackSignature(config.gateway.secret, timestamp, body) };
    const send = () => browser(app).post(`${API}/payments/callback`, body, { origin: null, headers });
    assert.equal((await send()).status, 404);
    await db.collection("bills").insertOne({ _id: reference, table: 1, orderIds: [], lines: [], total: 116, method: "Card", createdAt: new Date(), status: "Pending Payment" });
    assert.equal((await send()).status, 204);
    assert.equal((await send()).status, 409);
  });
});

describe("reservations", () => {
  test("upcoming bookings stay listed however many recent ones exist", async () => {
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const rows = Array.from({ length: 520 }, (_, i) => ({ _id: `R-REC${i}`, phoneMask: "", date: yesterday, time: "12:00", party: 2, status: "Completed", active: false, createdAt: new Date(), createdBy: "x", erasedAt: new Date() }));
    await db.collection("reservations").insertMany(rows);
    const manager = await as("Manager");
    const made = await manager.post(`${API}/reservations`, { name: "Upcoming Guest", phone: "03001112299", date: "2030-06-01", time: "12:00", party: 2 }, key());
    const listed = (await manager.get(`${API}/snapshot`)).body.reservations;
    assert.ok(listed.some((r) => r.id === made.body.id));
    await db.collection("reservations").deleteMany({ _id: /^R-REC/ });
  });
});

describe("recipes", () => {
  const ITEM = { name: "Recipe Latte", cat: "Coffee", price: 500, desc: "" };

  test("an Admin can give an item a recipe, and an order then takes that stock", async () => {
    const admin = await as("Admin");
    const created = await admin.post(`${API}/menu`, { ...ITEM, recipe: [{ ing: 1, qty: 0.02 }] });
    assert.equal(created.status, 201);
    const before = (await db.collection("inventory").findOne({ _id: 1 })).qtyMilli;
    const waiter = await as("Waiter");
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    assert.equal((await waiter.post(`${API}/orders`, { table: 5, lines: [{ id: created.body.id, qty: 2 }], notes: "" }, key())).status, 201);
    assert.equal((await db.collection("inventory").findOne({ _id: 1 })).qtyMilli, before - 40);
    const listed = (await admin.get(`${API}/menu`)).body.items.find((m) => m.id === created.body.id);
    assert.deepEqual(listed.recipe.map((r) => [r.ing, r.qty]), [[1, 0.02]]);
  });

  test("a saved edit without a recipe keeps the existing one", async () => {
    const admin = await as("Admin");
    const created = await admin.post(`${API}/menu`, { ...ITEM, name: "Kept Recipe", recipe: [{ ing: 2, qty: 0.1 }] });
    await admin.put(`${API}/menu/${created.body.id}`, { ...ITEM, name: "Kept Recipe", available: false });
    assert.equal((await db.collection("menu").findOne({ _id: created.body.id })).recipe.length, 1);
  });

  test("unknown or repeated ingredients are refused", async () => {
    const admin = await as("Admin");
    assert.equal((await admin.post(`${API}/menu`, { ...ITEM, name: "Bad One", recipe: [{ ing: 9999, qty: 1 }] })).status, 400);
    assert.equal((await admin.post(`${API}/menu`, { ...ITEM, name: "Bad Two", recipe: [{ ing: 1, qty: 1 }, { ing: 1, qty: 2 }] })).status, 400);
  });
});

describe("dependency graph and screens", () => {
  test("each edge carries the slides' line style: solid, dashed or dotted", () => {
    const model = { components: ["A", "B", "C", "D"], matrix: [["0", "2", "1", "1A"], ["0", "0", "0", "0"], ["0", "0", "0", "0"], ["0", "0", "0", "0"]] };
    assert.deepEqual(edges(model).map((e) => e.line), ["solid", "dashed", "dotted"]);
  });

  test("a declined bill offers cash, and the risk page draws the graph", () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, "..", "public", "js", file), "utf8");
    assert.match(read("billing.js"), /"Take cash"/);
    assert.match(read("risk.js"), /renderGraph/);
  });
});
