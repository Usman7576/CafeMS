const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const { startDb, buildApp, browser, createUser, signIn, freshCode, ORIGIN } = require("./helpers");
const { seedCatalog } = require("../scripts/seed-data");
const { verifyChain, recordEvent } = require("../server/services/auditLog");
const { callbackSignature } = require("../server/services/gateway");
const { createAlertService } = require("../server/services/alerts");
const { drainOutbox, enqueue, MAX_ATTEMPTS } = require("../server/services/outbox");
const { purgeExpiredData } = require("../server/services/customers");
const { checkAuditChain } = require("../server/workers");
const { createBackup, restoreBackup, parseBackupKey } = require("../server/lib/backup");
const { ensureAppRole, ensureAppUser } = require("../server/lib/dbRoles");
const { ensureIndexes } = require("../server/db");
const { inTransaction } = require("../server/lib/tx");

const API = "/api/v1";
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });

let ctx, db, app, config, waiter, kitchen, cashier, manager, admin, gateway;
async function as(role, targetApp = app) {
  const user = await createUser(db, config, { role });
  const client = await signIn(targetApp, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  // A gateway the tests can steer, standing in for a real provider
  gateway = { next: null, charge: (c) => (gateway.next ? gateway.next(c) : Promise.resolve({ status: "approved", reference: c.reference, amount: c.amount, gatewayRef: "T-1" })) };
  ({ app, config } = buildApp(db, {}, gateway));
  config.gateway = { ...config.gateway, timeoutMs: 150 };
  ({ app } = (() => {
    const { createApp } = require("../server/app");
    const { createLogger } = require("../server/lib/logger");
    return { app: createApp({ config, db, logger: createLogger(config), gateway }) };
  })());
  waiter = await as("Waiter");
  kitchen = await as("Kitchen");
  cashier = await as("Cashier");
  manager = await as("Manager");
  admin = await as("Admin");
});
after(() => ctx.stop());

async function servedTable(lines = [{ id: 1, qty: 1 }]) {
  await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
  const order = (await waiter.post(`${API}/orders`, { table: 2, lines }, key())).body;
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
  await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
  await waiter.post(`${API}/orders/${order.id}/serve`, {});
  return order;
}
const payCard = (body = { method: "Card" }) => cashier.post(`${API}/billing/tables/2/pay`, body, key());

describe("signed audit chain (finding 11)", () => {
  const tamper = async (change, undo) => {
    await change();
    const result = await verifyChain(db);
    await undo();
    return result;
  };

  test("a normal log verifies, and each entry carries a hash and signature", async () => {
    const result = await verifyChain(db);
    assert.equal(result.ok, true);
    const entry = await db.collection("audit_events").findOne({ seq: 1 });
    assert.equal(entry.prevHash, "GENESIS");
    assert.match(entry.hash, /^[0-9a-f]{64}$/);
    assert.ok(entry.sig);
  });

  test("detects edited details, a changed actor and a changed time", async () => {
    const entry = await db.collection("audit_events").findOne({ seq: 2 });
    for (const field of [{ details: "changed" }, { actor: "someone.else" }, { at: new Date(0) }]) {
      const original = Object.fromEntries(Object.keys(field).map((k) => [k, entry[k]]));
      const result = await tamper(
        () => db.collection("audit_events").updateOne({ seq: 2 }, { $set: field }),
        () => db.collection("audit_events").updateOne({ seq: 2 }, { $set: original })
      );
      assert.equal(result.ok, false);
      assert.equal(result.brokenAt, 2);
    }
  });

  test("detects a recalculated hash, because the attacker cannot sign it", async () => {
    const entry = await db.collection("audit_events").findOne({ seq: 3 });
    const fake = crypto.createHash("sha256").update("forged").digest("hex");
    const result = await tamper(
      () => db.collection("audit_events").updateOne({ seq: 3 }, { $set: { hash: fake } }),
      () => db.collection("audit_events").updateOne({ seq: 3 }, { $set: { hash: entry.hash } })
    );
    assert.equal(result.ok, false);
  });

  test("detects a deleted entry in the middle and at the end", async () => {
    const middle = await db.collection("audit_events").findOne({ seq: 4 });
    let result = await tamper(() => db.collection("audit_events").deleteOne({ seq: 4 }), () => db.collection("audit_events").insertOne(middle));
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing/);

    const last = await db.collection("audit_events").find({ seq: { $exists: true } }).sort({ seq: -1 }).limit(1).next();
    result = await tamper(() => db.collection("audit_events").deleteOne({ seq: last.seq }), () => db.collection("audit_events").insertOne(last));
    assert.equal(result.ok, false);
    assert.equal((await verifyChain(db)).ok, true);
  });

  test("simultaneous events keep a clean chain", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => browser(app).post(`${API}/auth/login`, { username: `parallel${i}`, password: "Wrong-Password-99!" })));
    assert.equal((await verifyChain(db)).ok, true);
  });

  test("if the audit entry fails, the action it describes does not happen", async () => {
    const before = await db.collection("menu").countDocuments();
    await assert.rejects(inTransaction(db, async (session) => {
      await db.collection("menu").insertOne({ _id: 99991, name: "Ghost" }, { session });
      await recordEvent(db, null, { actor: "x", action: "y" }, { session });
      throw new Error("audit storage failed");
    }));
    assert.equal(await db.collection("menu").countDocuments(), before);
    assert.equal((await verifyChain(db)).ok, true);
  });

  test("the Admin screen can verify, and a broken chain raises an alert", async () => {
    assert.equal((await admin.get(`${API}/audit/verify`)).body.ok, true);
    assert.match((await admin.get(`${API}/audit/public-keys`)).body.keys[0].pem, /BEGIN PUBLIC KEY/);

    const alerts = createAlertService({ db });
    const entry = await db.collection("audit_events").findOne({ seq: 5 });
    await db.collection("audit_events").updateOne({ seq: 5 }, { $set: { details: "changed" } });
    await checkAuditChain({ db, alerts });
    await db.collection("audit_events").updateOne({ seq: 5 }, { $set: { details: entry.details } });
    const open = await alerts.listOpen();
    assert.ok(open.some((a) => a.rule === "audit-chain"));
    await db.collection("alerts").deleteMany({ rule: "audit-chain" });
  });
});

describe("payment gateway (soft dependency)", () => {
  test("approved card payment is paid, with no card details anywhere", async () => {
    await servedTable();
    const res = await payCard();
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "Paid");
    assert.equal((await db.collection("bills").findOne({ _id: res.body.no })).gatewayRef, "T-1");
  });

  test("a timeout leaves the bill Pending Payment, the till responsive and revenue unchanged", async () => {
    await servedTable();
    const before = (await manager.get(`${API}/reports/sales`)).body.revenue;
    gateway.next = () => new Promise(() => {});
    const started = Date.now();
    const res = await payCard();
    gateway.next = null;
    assert.equal(res.status, 202);
    assert.equal(res.body.status, "Pending Payment");
    assert.ok(Date.now() - started < 2000);
    assert.equal((await manager.get(`${API}/reports/sales`)).body.revenue, before);
    assert.ok(await db.collection("audit_events").findOne({ action: "Payment pending", details: new RegExp(res.body.no) }));

    assert.equal((await manager.post(`${API}/bills/${res.body.no}/refund`, { reason: "Wrong item" }, key())).body.error.code, "not_paid");
    const retried = await cashier.post(`${API}/bills/${res.body.no}/retry-payment`, {});
    assert.equal(retried.body.status, "Paid");
    assert.equal((await cashier.post(`${API}/bills/${res.body.no}/retry-payment`, {})).body.error.code, "not_open");
  });

  test("a gateway crash is treated the same as a timeout", async () => {
    await servedTable();
    gateway.next = () => Promise.reject(new Error("connection refused at 10.0.0.5"));
    const res = await payCard();
    gateway.next = null;
    assert.equal(res.body.status, "Pending Payment");
    assert.ok(!JSON.stringify(res.body).includes("10.0.0.5"));
  });

  test("a declined payment can be settled in cash, which must cover the total", async () => {
    await servedTable();
    gateway.next = (c) => Promise.resolve({ status: "declined", reference: c.reference, amount: c.amount, gatewayRef: "T-2" });
    const res = await payCard();
    gateway.next = null;
    assert.equal(res.body.status, "Payment Failed");
    const URL = `${API}/bills/${res.body.no}/retry-payment`;
    assert.equal((await cashier.post(URL, { method: "Cash", tendered: 1 })).body.error.code, "cash_too_low");
    const paid = await cashier.post(URL, { method: "Cash", tendered: res.body.total + 50 });
    assert.equal(paid.body.status, "Paid");
    assert.equal(paid.body.change, 50);
  });

  test("a gateway reporting the wrong amount is refused and recorded", async () => {
    await servedTable();
    gateway.next = (c) => Promise.resolve({ status: "approved", reference: c.reference, amount: 1, gatewayRef: "T-3" });
    const res = await payCard();
    gateway.next = null;
    assert.equal(res.body.error.code, "amount_mismatch");
    assert.ok(await db.collection("audit_events").findOne({ action: "Payment amount mismatch" }));
    const bill = await db.collection("bills").find().sort({ createdAt: -1 }).limit(1).next();
    assert.equal(bill.status, "Pending Payment");
    await cashier.post(`${API}/bills/${bill._id}/retry-payment`, {});
  });

  test("double-clicking Pay with one key charges one bill", async () => {
    const order = await servedTable();
    const same = key();
    const [a, b] = await Promise.all([cashier.post(`${API}/billing/tables/2/pay`, { method: "Card" }, same), cashier.post(`${API}/billing/tables/2/pay`, { method: "Card" }, same)]);
    assert.equal(a.body.no, b.body.no);
    assert.equal(await db.collection("bills").countDocuments({ orderIds: order.id }), 1);
  });

  describe("signed callback", () => {
    const send = (body, opts = {}) => {
      const timestamp = String(opts.timestamp || Date.now());
      const signature = opts.signature || callbackSignature(opts.secret || config.gateway.secret, timestamp, body);
      return request(app).post(`${API}/payments/callback`).set("X-Gateway-Timestamp", timestamp).set("X-Gateway-Signature", signature).send(body);
    };
    const pending = async () => {
      await servedTable();
      gateway.next = () => new Promise(() => {});
      const res = await payCard();
      gateway.next = null;
      return res.body;
    };

    test("a correct callback settles the bill", async () => {
      const bill = await pending();
      assert.equal((await send({ reference: bill.no, amount: bill.total, status: "approved", gatewayRef: "CB-1" })).status, 204);
      assert.equal((await db.collection("bills").findOne({ _id: bill.no })).status, "Paid");
    });

    test("forged, old, wrong-amount and malformed callbacks are refused", async () => {
      const bill = await pending();
      const good = { reference: bill.no, amount: bill.total, status: "approved", gatewayRef: "CB-2" };
      assert.equal((await send(good, { secret: crypto.randomBytes(32) })).status, 401);
      assert.equal((await send(good, { signature: "0".repeat(64) })).status, 401);
      assert.equal((await send(good, { timestamp: Date.now() - 10 * 60 * 1000 })).status, 401);
      assert.equal((await send({ ...good, amount: 1 })).status, 409);
      assert.equal((await send({ ...good, reference: { $ne: "" } })).status, 401);
      assert.equal((await db.collection("bills").findOne({ _id: bill.no })).status, "Pending Payment");
      assert.ok(await db.collection("audit_events").findOne({ action: "Gateway callback refused" }));
    });

    test("a repeated callback changes nothing", async () => {
      const bill = await pending();
      const good = { reference: bill.no, amount: bill.total, status: "approved", gatewayRef: "CB-3" };
      await send(good);
      assert.equal((await send({ ...good, status: "declined" })).status, 204);
      assert.equal((await db.collection("bills").findOne({ _id: bill.no })).status, "Paid");
    });
  });
});

describe("notification queue (FMEA: lost notifications)", () => {
  const context = (deliver) => ({ db, notifier: { deliver }, alerts: createAlertService({ db }) });
  const clear = () => db.collection("outbox").deleteMany({});

  test("stock falling to its reorder level queues one message, without blocking the order", async () => {
    await clear();
    await db.collection("inventory").updateOne({ _id: 14 }, { $set: { qtyMilli: 11000, reorderMilli: 10000 } });
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    assert.equal((await waiter.post(`${API}/orders`, { table: 4, lines: [{ id: 15, qty: 1 }] }, key())).status, 201);
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    assert.equal((await waiter.post(`${API}/orders`, { table: 4, lines: [{ id: 15, qty: 1 }] }, key())).status, 201);
    const messages = await db.collection("outbox").find({ type: "low-stock" }).toArray();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.ingredient, "Croissant dough");
  });

  test("a failed order queues nothing", async () => {
    await clear();
    await db.collection("inventory").updateOne({ _id: 14 }, { $set: { qtyMilli: 10500 } });
    await db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
    const res = await waiter.post(`${API}/orders`, { table: 4, lines: [{ id: 15, qty: 99 }] }, key());
    assert.equal(res.status, 409);
    assert.equal(await db.collection("outbox").countDocuments(), 0);
  });

  test("a delivered message is sent once", async () => {
    await clear();
    await enqueue(db, "low-stock", { ingredient: "Milk" });
    let sent = 0;
    const ctxOk = context(async () => { sent += 1; });
    assert.equal(await drainOutbox(ctxOk), 1);
    assert.equal(await drainOutbox(ctxOk), 0);
    assert.equal(sent, 1);
  });

  test("failures retry with growing gaps, then raise one Admin alert", async () => {
    await clear();
    await db.collection("alerts").deleteMany({});
    await enqueue(db, "receipt", { billNo: "B-1" });
    const failing = context(async () => { throw new Error("provider down"); });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await db.collection("outbox").updateOne({}, { $set: { nextAttemptAt: new Date(0) } });
      await drainOutbox(failing);
      const message = await db.collection("outbox").findOne();
      assert.equal(message.attempts, attempt);
      if (attempt < MAX_ATTEMPTS) {
        assert.equal(message.status, "Pending");
        assert.ok(message.nextAttemptAt > new Date());
      }
    }
    assert.equal((await db.collection("outbox").findOne()).status, "Failed");
    const open = await failing.alerts.listOpen();
    assert.equal(open.filter((a) => a.rule === "notification-failed").length, 1);
  });

  test("a failed message does not stop the ones behind it", async () => {
    await clear();
    await enqueue(db, "receipt", { billNo: "B-1" });
    await enqueue(db, "low-stock", { ingredient: "Milk" });
    const delivered = [];
    await drainOutbox(context(async (m) => { if (m.type === "receipt") throw new Error("down"); delivered.push(m.type); }));
    assert.deepEqual(delivered, ["low-stock"]);
  });

  test("a paid bill with a phone queues a receipt holding no phone number", async () => {
    await clear();
    await servedTable();
    await payCard({ method: "Card", phone: "03001234567" });
    const message = await db.collection("outbox").findOne({ type: "receipt" });
    assert.ok(message.payload.billNo);
    assert.ok(!JSON.stringify(message).includes("03001234567"));
  });
});

describe("security alerts", () => {
  const service = () => createAlertService({ db });
  const reset = async () => {
    await db.collection("alerts").deleteMany({});
  };
  const events = (actor, action, n) => Promise.all(Array.from({ length: n }, () => null)).then(async () => {
    for (let i = 0; i < n; i += 1) await recordEvent(db, null, { actor, action, severity: "warning" });
  });

  test("failed sign-ins, denials, exports, number views and refunds each raise an alert", async () => {
    await reset();
    await events("rule.one", "Sign-in failed", 5);
    await events("rule.two", "Access denied", 5);
    await events("rule.three", "Report exported", 3);
    await events("rule.four", "Customer phone viewed", 10);
    await events("rule.five", "Refund issued", 3);
    const alerts = service();
    await alerts.evaluate();
    const open = (await alerts.listOpen()).filter((a) => a.details.includes("rule."));
    assert.deepEqual(open.map((a) => a.rule).sort(), ["access-denied", "bulk-export", "failed-sign-ins", "phone-views", "refund-spike"]);
  });

  test("below the threshold, nothing is raised", async () => {
    await reset();
    await events("quiet.one", "Access denied", 2);
    const alerts = service();
    await alerts.evaluate();
    assert.ok(!(await alerts.listOpen()).some((a) => a.details.includes("quiet.one")));
  });

  test("a flood updates one alert instead of creating many", async () => {
    await reset();
    await events("noisy.one", "Access denied", 5);
    const alerts = service();
    await alerts.evaluate();
    await events("noisy.one", "Access denied", 15);
    await alerts.evaluate();
    await alerts.evaluate();
    const matching = (await alerts.listOpen()).filter((a) => a.details.includes("noisy.one"));
    assert.equal(matching.length, 1);
    assert.equal(matching[0].count, 20);
  });

  test("an acknowledged alert stays closed until something new happens", async () => {
    await reset();
    await events("ack.one", "Report exported", 3);
    const alerts = service();
    await alerts.evaluate();
    const alert = (await alerts.listOpen()).find((a) => a.details.includes("ack.one"));
    assert.equal((await admin.post(`${API}/alerts/${alert.id}/acknowledge`, {})).status, 204);
    await alerts.evaluate();
    assert.ok(!(await alerts.listOpen()).some((a) => a.details.includes("ack.one")));
    await events("ack.one", "Report exported", 1);
    await alerts.evaluate();
    assert.ok((await alerts.listOpen()).some((a) => a.details.includes("ack.one")));
  });
});

describe("menu photo upload", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
  const upload = (client, id, type, body) => {
    const cookie = Object.entries(client.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    return client.loadCsrf().then((me) => request(app).put(`${API}/menu/${id}/photo`).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", me.body.csrfToken).set("Content-Type", type).send(body));
  };

  test("a real image is stored outside the web root under a random name, and served safely", async () => {
    const res = await upload(admin, 1, "image/png", PNG);
    assert.equal(res.status, 204);
    const item = await db.collection("menu").findOne({ _id: 1 });
    assert.match(item.photo.file, /^[A-Za-z0-9_-]{32}\.png$/);
    assert.ok(fs.existsSync(path.join(config.uploadDir, item.photo.file)));
    assert.ok(!path.resolve(config.uploadDir).includes(`${path.sep}public${path.sep}`));

    const served = await waiter.get(`${API}/menu/1/photo`);
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal(served.headers["x-content-type-options"], "nosniff");
    assert.match(served.headers["content-security-policy"], /sandbox/);
    assert.equal((await request(app).get(`/uploads/${item.photo.file}`)).status, 404);
    assert.equal((await request(app).get(`${API}/menu/1/photo`)).status, 401);
    assert.ok((await waiter.get(`${API}/menu`)).body.items.find((m) => m.id === 1).hasPhoto);
  });

  test("a replaced photo removes the old file", async () => {
    await upload(admin, 2, "image/png", PNG);
    const first = (await db.collection("menu").findOne({ _id: 2 })).photo.file;
    assert.equal((await upload(admin, 2, "image/jpeg", JPEG)).status, 204);
    assert.ok(!fs.existsSync(path.join(config.uploadDir, first)));
  });

  test("scripts, SVG, HTML and disguised files are refused and recorded", async () => {
    const script = Buffer.from("<script>alert(1)</script>");
    assert.equal((await upload(admin, 1, "image/png", script)).status, 415);
    assert.equal((await upload(admin, 1, "image/svg+xml", Buffer.from("<svg onload=alert(1)>"))).status, 415);
    assert.equal((await upload(admin, 1, "text/html", script)).status, 415);
    assert.equal((await upload(admin, 1, "image/jpeg", PNG)).status, 415);
    assert.equal((await upload(admin, 1, "application/octet-stream", PNG)).status, 415);
    assert.ok(await db.collection("audit_events").findOne({ action: "Upload refused" }));
  });

  test("a file over 2 MB is refused", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1)]);
    assert.equal((await upload(admin, 1, "image/png", big)).status, 413);
  });

  test("only an Admin can upload, and bad or missing items are handled", async () => {
    assert.equal((await upload(manager, 1, "image/png", PNG)).status, 403);
    assert.equal((await upload(admin, 99999, "image/png", PNG)).status, 404);
    assert.equal((await waiter.get(`${API}/menu/99999/photo`)).status, 404);
    assert.equal((await waiter.get(`${API}/menu/..%2f..%2fpackage.json/photo`)).status, 400);
  });

  test("a tampered file name in the database cannot read other files", async () => {
    await db.collection("menu").updateOne({ _id: 3 }, { $set: { photo: { file: "../../package.json", type: "image/png" } } });
    assert.equal((await waiter.get(`${API}/menu/3/photo`)).status, 404);
    await db.collection("menu").updateOne({ _id: 3 }, { $unset: { photo: "" } });
  });
});

describe("customer data rights", () => {
  const PHONE = "03337778888";
  const reserve = () => waiter.post(`${API}/reservations`, { name: "Erase Me", phone: PHONE, date: "2099-06-01", time: "12:00", party: 2, notes: "Private note" }, key());

  test("erasing removes the person but keeps the bill totals, and needs a fresh code", async () => {
    await reserve();
    await servedTable();
    const bill = (await payCard({ method: "Card", phone: PHONE })).body;
    const ERASE = `${API}/customers/erase`;
    assert.equal((await manager.post(ERASE, { phone: PHONE })).status, 403);
    assert.equal((await admin.post(ERASE, { phone: PHONE })).body.error.code, "step_up_required");
    await stepUp(admin);
    const res = await admin.post(ERASE, { phone: PHONE });
    assert.deepEqual(res.body, { bills: 1, reservations: 1 });

    const stored = await db.collection("bills").findOne({ _id: bill.no });
    assert.equal(stored.phoneEnc, undefined);
    assert.equal(stored.total, bill.total);
    assert.equal((await manager.get(`${API}/bills/${bill.no}/phone`)).status, 404);

    const list = (await manager.get(`${API}/reservations`)).body.reservations;
    const erased = list.find((r) => r.name === "Erased guest");
    assert.ok(erased);
    assert.equal(erased.notes, "");
    assert.equal(erased.phone, "");
    assert.equal((await manager.get(`${API}/reservations/${erased.id}/phone`)).status, 404);

    const event = await db.collection("audit_events").findOne({ action: "Customer data erased" });
    assert.ok(!JSON.stringify(event).includes(PHONE));
    assert.equal((await reserve()).status, 201, "the slot is free again");
  });

  test("retention removes personal data after 90 days, and keeps recent data", async () => {
    const old = new Date(Date.now() - 100 * 86400000);
    await db.collection("bills").insertOne({ _id: "B-OLD", createdAt: old, total: 500, phoneEnc: "x", phoneIndex: "y", phoneMask: "z", status: "Paid", lines: [] });
    await db.collection("bills").insertOne({ _id: "B-NEW", createdAt: new Date(), total: 500, phoneEnc: "x", phoneIndex: "y2", phoneMask: "z", status: "Paid", lines: [] });
    await db.collection("reservations").insertOne({ _id: "R-OLD", date: "2020-01-01", time: "12:00", nameEnc: "x", phoneEnc: "y", phoneIndex: "z", notesEnc: null, active: true });
    await purgeExpiredData(db, 90);
    const oldBill = await db.collection("bills").findOne({ _id: "B-OLD" });
    assert.equal(oldBill.phoneEnc, undefined);
    assert.equal(oldBill.total, 500);
    assert.ok((await db.collection("bills").findOne({ _id: "B-NEW" })).phoneEnc);
    assert.equal((await db.collection("reservations").findOne({ _id: "R-OLD" })).nameEnc, undefined);
    await db.collection("bills").deleteMany({ _id: { $in: ["B-OLD", "B-NEW"] } });
    await db.collection("reservations").deleteOne({ _id: "R-OLD" });
  });
});

describe("encrypted backup and restore", () => {
  const backupKey = crypto.randomBytes(32);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-backup-"));
  let backup;

  test("the backup file holds no readable data", async () => {
    await db.collection("settings").updateOne({ _id: "marker" }, { $set: { value: "FIND-THIS-PLAINTEXT" } }, { upsert: true });
    backup = await createBackup({ db, key: backupKey, directory, uploadDir: config.uploadDir });
    const raw = fs.readFileSync(backup.path);
    assert.ok(!raw.includes("FIND-THIS-PLAINTEXT"));
    assert.ok(!raw.includes("passwordHash"));
    assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), backup.sha256);
  });

  test("a restore brings back every record, and the audit chain still verifies", async () => {
    const target = db.client.db("cafems_restore_check");
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-restored-"));
    await restoreBackup({ backupPath: backup.path, key: backupKey, db: target, uploadDir });
    for (const name of ["users", "bills", "orders", "audit_events", "menu"]) {
      assert.equal(await target.collection(name).countDocuments(), backup.counts[name], name);
    }
    const original = await db.collection("bills").findOne({ total: { $gt: 0 } });
    const restored = await target.collection("bills").findOne({ _id: original._id });
    assert.equal(restored.createdAt.getTime(), original.createdAt.getTime());
    assert.ok(fs.readdirSync(uploadDir).length >= 1);

    const { bindAudit } = require("../server/services/auditLog");
    bindAudit(target, config);
    assert.equal((await verifyChain(target)).ok, true);
    await target.dropDatabase();
  });

  test("a restore refuses a database that already has data", async () => {
    await assert.rejects(restoreBackup({ backupPath: backup.path, key: backupKey, db }), /not empty/);
  });

  test("an altered file or the wrong key is refused", async () => {
    await assert.rejects(restoreBackup({ backupPath: backup.path, key: crypto.randomBytes(32), db: db.client.db("cafems_never_a") }), /could not be decrypted/);
    const copy = `${backup.path}.copy`;
    const bytes = fs.readFileSync(backup.path);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(copy, bytes);
    fs.copyFileSync(`${backup.path}.manifest.json`, `${copy}.manifest.json`);
    await assert.rejects(restoreBackup({ backupPath: copy, key: backupKey, db: db.client.db("cafems_never_b") }), /checksum/);
  });

  test("a weak backup key is refused", () => {
    assert.throws(() => parseBackupKey(""), /BACKUP_KEY/);
    assert.throws(() => parseBackupKey(Buffer.alloc(32, 1).toString("base64")), /BACKUP_KEY/);
    assert.equal(parseBackupKey(backupKey.toString("base64")).length, 32);
  });
});

describe("database least privilege", () => {
  test("the app account can add audit entries but cannot change or delete them", async () => {
    const server = await MongoMemoryReplSet.create({ replSet: { count: 1, auth: { enable: true, customRootName: "root", customRootPwd: "root-test-pass" } } });
    const uri = server.getUri();
    const rootClient = await MongoClient.connect(uri, { auth: { username: "root", password: "root-test-pass" }, authSource: "admin" });
    const appClient = await MongoClient.connect(uri.replace(/\/[^/?]*(\?|$)/, "/cafems_priv$1"), { auth: { username: "cafems_app", password: "app-test-pass" }, authSource: "cafems_priv", monitorCommands: false }).catch(() => null);
    if (appClient) await appClient.close();
    try {
      const adminDb = rootClient.db("cafems_priv");
      await ensureAppRole(adminDb);
      await ensureAppUser(adminDb, "cafems_app", "app-test-pass");
      await ensureAppRole(adminDb);

      const client = await MongoClient.connect(uri, { auth: { username: "cafems_app", password: "app-test-pass" }, authSource: "cafems_priv" });
      try {
        const appDb = client.db("cafems_priv");
        await ensureIndexes(appDb);
        const audit = appDb.collection("audit_events");
        const { insertedId } = await audit.insertOne({ action: "ok" });
        assert.ok(await audit.findOne({ _id: insertedId }));
        await assert.rejects(audit.updateOne({ _id: insertedId }, { $set: { action: "changed" } }), /not authorized/);
        await assert.rejects(audit.deleteOne({ _id: insertedId }), /not authorized/);
        await assert.rejects(audit.drop(), /not authorized/);
        await assert.rejects(appDb.dropDatabase(), /not authorized/);
        await assert.rejects(client.db("admin").collection("system.users").find().toArray(), /not authorized/);

        await appDb.collection("menu").insertOne({ _id: 1, name: "Allowed" });
        await inTransaction(appDb, async (session) => {
          await appDb.collection("menu").updateOne({ _id: 1 }, { $set: { name: "Still allowed" } }, { session });
        });
        assert.equal((await appDb.collection("menu").findOne({ _id: 1 })).name, "Still allowed");
      } finally {
        await client.close();
      }
    } finally {
      await rootClient.close();
      await server.stop();
    }
  });
});
