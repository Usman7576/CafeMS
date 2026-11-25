// Grand Development Quiz: automated proof for Q1 (authentication and access control), Q2 (transactional
// submission and integrity) and Q3 (workflow, querying and resilience), including every examiner acceptance
// test: replay after logout, concurrent duplicates, filters + page 2, two claims with one version, finalize
// without claim or as the wrong actor, another owner's record, and a forced audit/database failure.
// Run: npm run test:quiz
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { startDb, buildApp, createUser, signIn, browser } = require("./helpers");
const { createApp } = require("../server/app");
const { createLogger } = require("../server/lib/logger");
const { SESSION_COOKIE } = require("../server/services/sessions");

const API = "/api/v1";
let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

let n = 0;
const person = async (role) => {
  n += 1;
  const user = await createUser(db, config, { role, username: `${role.toLowerCase()}.${n}` });
  return Object.assign(await signIn(app, db, user), { username: user.username, user });
};
const body = (extra = {}) => ({ title: `Broken fridge door ${crypto.randomBytes(3).toString("hex")}`, description: "The kitchen fridge door does not close properly.", category: "Equipment", ...extra });
const submit = (client, extra) => client.post(`${API}/requests`, body(extra));
const historyCount = (id) => db.collection("request_history").countDocuments({ requestId: id });
// Makes every write to request_history fail, to prove the record and its history are saved together
const breakHistory = () => db.command({ collMod: "request_history", validator: { $expr: { $eq: [1, 0] } }, validationAction: "error", validationLevel: "strict" });
const fixHistory = () => db.command({ collMod: "request_history", validator: {}, validationLevel: "off" });

describe("Q1 secure authentication and access control", () => {
  test("passwords are stored as Argon2id hashes; a refresh keeps a valid login", async () => {
    const owner = await person("Waiter");
    const stored = await db.collection("users").findOne({ username: owner.username });
    assert.match(stored.passwordHash, /^\$argon2id\$/);
    assert.ok(!stored.passwordHash.includes(owner.user.password));
    assert.equal((await owner.get(`${API}/auth/me`)).status, 200);
    assert.equal((await owner.get(`${API}/auth/me`)).status, 200, "a second load (refresh) is still signed in");
  });

  test("an expired session and a forged token both fail", async () => {
    const owner = await person("Waiter");
    await db.collection("sessions").updateOne({ username: owner.username }, { $set: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await owner.get(`${API}/requests`)).status, 401);
    const forged = browser(app);
    forged.jar[SESSION_COOKIE] = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.forged";
    assert.equal((await forged.get(`${API}/requests`)).status, 401);
  });

  test("EXAMINER: replaying the credential after logout is denied, also from a second tab", async () => {
    const owner = await person("Waiter");
    const secondTab = browser(app);
    secondTab.jar[SESSION_COOKIE] = owner.jar[SESSION_COOKIE];
    assert.equal((await secondTab.get(`${API}/requests`)).status, 200, "second tab works while signed in");
    assert.equal((await owner.post(`${API}/auth/logout`, {})).status, 204);
    const replay = browser(app);
    replay.jar[SESSION_COOKIE] = secondTab.jar[SESSION_COOKIE];
    assert.equal((await replay.get(`${API}/requests`)).status, 401);
    assert.equal((await secondTab.get(`${API}/requests`)).status, 401);
  });

  test("401 for not signed in, 403 for signed in but not allowed; errors expose no hashes or stack traces", async () => {
    const anonymous = await browser(app).get(`${API}/requests`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.error.code, "not_signed_in");
    const kitchen = await person("Kitchen");
    const claim = await kitchen.post(`${API}/requests/SR-1/claim`, { version: 1 });
    assert.equal(claim.status, 403);
    assert.equal(claim.body.error.code, "forbidden");
    for (const res of [anonymous, claim]) assert.doesNotMatch(JSON.stringify(res.body), /argon2|passwordHash|stack|at .+\.js/);
  });

  test("forged owner, status, version and timestamp fields are refused; identity comes from the session", async () => {
    const owner = await person("Waiter");
    for (const forged of [{ owner: "someone.else" }, { status: "Resolved" }, { version: 7 }, { createdAt: "2020-01-01" }, { reviewer: "manager.1" }]) {
      const res = await submit(owner, forged);
      assert.equal(res.status, 400, JSON.stringify(forged));
    }
    assert.equal(await db.collection("staff_requests").countDocuments({ owner: owner.username }), 0);
  });
});

describe("Q2 transactional submission and integrity", () => {
  test("validation: trimmed title of at least 5, description of at least 15, a known category", async () => {
    const owner = await person("Waiter");
    for (const bad of [{ title: "   ab  c   " }, { description: "  too short     " }, { category: "Snacks" }, { title: 5 }, { contactPhone: "123" }]) {
      const res = await submit(owner, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.ok(res.body.error.message.length > 0);
    }
  });

  test("the response is the committed record: server owner, unique ID, Pending, version 1, timestamps", async () => {
    const owner = await person("Waiter");
    const res = await submit(owner, { title: "   Need   more   napkins   ", contactPhone: "03211234567" });
    assert.equal(res.status, 201);
    assert.match(res.body.id, /^SR-\d+$/);
    assert.equal(res.body.title, "Need more napkins");
    assert.equal(res.body.owner, owner.username);
    assert.equal(res.body.status, "Pending");
    assert.equal(res.body.version, 1);
    assert.ok(res.body.createdAt && res.body.updatedAt);
    const stored = await db.collection("staff_requests").findOne({ _id: res.body.id });
    assert.equal(stored.status, "Pending");
    assert.equal(await historyCount(res.body.id), 1);
  });

  test("EXAMINER: concurrent duplicate submissions (case and space variants) give exactly one record and one creation event", async () => {
    const owner = await person("Cashier");
    const variants = ["Card machine is down", "card machine is DOWN", "  Card   machine is down ", "CARD MACHINE IS DOWN", "Card machine  is down"];
    const results = await Promise.all(variants.map((title) => submit(owner, { title })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
    assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "duplicate_title"));
    const docs = await db.collection("staff_requests").find({ owner: owner.username }).toArray();
    assert.equal(docs.length, 1);
    assert.equal(await historyCount(docs[0]._id), 1);
    assert.equal(await db.collection("audit_events").countDocuments({ action: "Staff request created", details: new RegExp(`^${docs[0]._id} `) }), 1);
  });

  test("different owners may use the same title", async () => {
    const [a, b] = [await person("Waiter"), await person("Waiter")];
    assert.equal((await submit(a, { title: "Shared title here" })).status, 201);
    assert.equal((await submit(b, { title: "Shared title here" })).status, 201);
  });

  test("EXAMINER: a forced audit write failure leaves no record (atomic creation)", async () => {
    const owner = await person("Waiter");
    await breakHistory();
    try {
      const res = await submit(owner, { title: "Should never be saved" });
      assert.equal(res.status, 500);
      assert.doesNotMatch(JSON.stringify(res.body), /validation|request_history|Mongo/);
    } finally {
      await fixHistory();
    }
    assert.equal(await db.collection("staff_requests").countDocuments({ owner: owner.username }), 0);
    assert.equal((await submit(owner, { title: "Should never be saved" })).status, 201, "the title is free again: nothing half-saved");
  });

  test("records persist after the app restarts with a new database connection", async () => {
    const owner = await person("Waiter");
    const created = (await submit(owner, { title: "Persist across restart" })).body;
    const client = await MongoClient.connect(ctx.uri);
    try {
      const restarted = createApp({ config, db: client.db("cafems_test"), logger: createLogger(config) });
      const again = browser(restarted);
      again.jar[SESSION_COOKIE] = owner.jar[SESSION_COOKIE];
      const res = await again.get(`${API}/requests/${created.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.title, "Persist across restart");
    } finally {
      await client.close();
    }
  });
});

describe("Q3 A database-driven retrieval", () => {
  let owner, other, manager, ids;
  before(async () => {
    owner = await person("Waiter");
    other = await person("Waiter");
    manager = await person("Manager");
    ids = [];
    const cats = ["Equipment", "Supplies", "Equipment", "Maintenance"];
    for (let i = 0; i < 12; i += 1) ids.push((await submit(owner, { title: `Coffee grinder issue ${i}`, category: cats[i % 4] })).body.id);
    for (let i = 0; i < 3; i += 1) await submit(other, { title: `Coffee grinder issue ${i}`, category: "Equipment" });
  });

  test("EXAMINER: combined filters with page 2 give the right scoped results and total", async () => {
    const q = (page) => owner.get(`${API}/requests?search=COFFEE%20grinder&category=Equipment&status=Pending&sort=oldest&page=${page}`);
    const [p1, p2] = [await q(1), await q(2)];
    assert.equal(p1.status, 200);
    assert.equal(p1.body.total, 6, "6 of the owner's 12 are Equipment; the other owner's 3 are out of scope");
    assert.equal(p1.body.pageSize, 5);
    assert.equal(p1.body.items.length, 5);
    assert.equal(p2.body.items.length, 1);
    assert.equal(p2.body.page, 2);
    const all = [...p1.body.items, ...p2.body.items];
    assert.ok(all.every((r) => r.owner === owner.username && r.category === "Equipment" && r.status === "Pending"));
    assert.equal(new Set(all.map((r) => r.id)).size, 6, "no record repeated across pages");
  });

  test("records with identical timestamps keep a stable order across pages", async () => {
    const same = new Date("2026-01-01T10:00:00Z");
    await db.collection("staff_requests").updateMany({ _id: { $in: ids } }, { $set: { createdAt: same } });
    const pages = [];
    for (let p = 1; p <= 3; p += 1) pages.push(...(await owner.get(`${API}/requests?page=${p}&sort=newest`)).body.items.map((r) => r.id));
    const pages2 = [];
    for (let p = 1; p <= 3; p += 1) pages2.push(...(await owner.get(`${API}/requests?page=${p}&sort=newest`)).body.items.map((r) => r.id));
    assert.equal(new Set(pages).size, 12);
    assert.deepEqual(pages, pages2);
    assert.deepEqual(pages, [...pages].sort((a, b) => Number(b.slice(3)) - Number(a.slice(3))), "ties broken by sequence number");
  });

  test("invalid page, sort and filter values are refused", async () => {
    for (const q of ["page=0", "page=-1", "page=abc", "sort=title", "category=Snacks", "status=Done", "owner=x", "search=" + "a".repeat(101)]) {
      assert.equal((await owner.get(`${API}/requests?${q}`)).status, 400, q);
    }
  });

  test("search treats regex characters literally", async () => {
    const res = await owner.get(`${API}/requests?search=${encodeURIComponent(".*")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
  });

  test("a reviewer's scope is Pending records plus the ones they claimed", async () => {
    const res = await manager.get(`${API}/requests?search=coffee%20grinder&page=1`);
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 15);
  });
});

describe("Q3 B/C state machine, concurrency, history and privacy", () => {
  let owner, stranger, manager, manager2;
  before(async () => {
    owner = await person("Kitchen");
    stranger = await person("Kitchen");
    manager = await person("Manager");
    manager2 = await person("Manager");
  });
  const create = async (title) => (await submit(owner, { title, contactPhone: "03001234567" })).body;
  const record = (id) => db.collection("staff_requests").findOne({ _id: id });

  test("Role 1 cannot change status", async () => {
    const r = await create("Owner tries to claim");
    for (const action of ["claim", "resolve"]) assert.equal((await owner.post(`${API}/requests/${r.id}/${action}`, { version: 1 })).status, 403);
    assert.equal((await record(r.id)).status, "Pending");
  });

  test("Pending to In Review to Resolved, each with a history event", async () => {
    const r = await create("Full lifecycle resolve");
    const claimed = await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.status, "In Review");
    assert.equal(claimed.body.reviewer, manager.username);
    assert.equal(claimed.body.version, 2);
    const resolved = await manager.post(`${API}/requests/${r.id}/resolve`, { version: 2 });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.status, "Resolved");
    const h = (await owner.get(`${API}/requests/${r.id}/history`)).body.history;
    assert.deepEqual(h.map((e) => [e.from, e.to, e.version, e.actor]), [[null, "Pending", 1, owner.username], ["Pending", "In Review", 2, manager.username], ["In Review", "Resolved", 3, manager.username]]);
    assert.ok(h.every((e) => e.at));
  });

  test("rejection needs a non-empty reason; terminal records cannot be modified", async () => {
    const r = await create("Lifecycle reject path");
    await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    assert.equal((await manager.post(`${API}/requests/${r.id}/reject`, { version: 2, reason: "   " })).status, 400);
    assert.equal((await manager.post(`${API}/requests/${r.id}/reject`, { version: 2 })).status, 400);
    const rejected = await manager.post(`${API}/requests/${r.id}/reject`, { version: 2, reason: "Already fixed last week" });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.reason, "Already fixed last week");
    for (const [action, payload] of [["resolve", { version: 3 }], ["reject", { version: 3, reason: "again" }], ["claim", { version: 3 }]]) {
      const res = await manager.post(`${API}/requests/${r.id}/${action}`, payload);
      assert.equal(res.status, 409, action);
    }
    assert.equal(await historyCount(r.id), 3);
  });

  test("EXAMINER: finalize without claim, or as the wrong actor, is denied with no state or history change", async () => {
    const r = await create("Finalize too early");
    const early = await manager.post(`${API}/requests/${r.id}/resolve`, { version: 1 });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "wrong_status");
    await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    const wrong = await manager2.post(`${API}/requests/${r.id}/resolve`, { version: 2 });
    assert.ok([403, 404].includes(wrong.status));
    const now = await record(r.id);
    assert.equal(now.status, "In Review");
    assert.equal(now.version, 2);
    assert.equal(await historyCount(r.id), 2);
  });

  test("EXAMINER: two claims with the identical version give one success, one conflict and one transition event", async () => {
    const r = await create("Race to claim this");
    const results = await Promise.all([manager.post(`${API}/requests/${r.id}/claim`, { version: 1 }), manager2.post(`${API}/requests/${r.id}/claim`, { version: 1 })]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    assert.equal(results.find((x) => x.status === 409).body.error.code, "stale_version");
    const winner = results.find((x) => x.status === 200).body.reviewer;
    assert.equal((await record(r.id)).reviewer, winner, "the committed reviewer was not overwritten");
    assert.equal(await db.collection("request_history").countDocuments({ requestId: r.id, action: "Claimed" }), 1);
  });

  test("a stale version is refused without overwriting", async () => {
    const r = await create("Stale version check");
    await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    const stale = await manager.post(`${API}/requests/${r.id}/resolve`, { version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "stale_version");
    assert.equal((await record(r.id)).status, "In Review");
  });

  test("EXAMINER: another owner's record and history are not disclosed, even by changing the ID", async () => {
    const r = await create("Private to the owner");
    assert.equal((await stranger.get(`${API}/requests/${r.id}`)).status, 404);
    assert.equal((await stranger.get(`${API}/requests/${r.id}/history`)).status, 404);
    assert.ok(!(await stranger.get(`${API}/requests?page=1`)).body.items.some((x) => x.id === r.id));
    await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    assert.equal((await manager2.get(`${API}/requests/${r.id}/history`)).status, 404, "a reviewer who did not claim it cannot see it");
    assert.equal((await owner.get(`${API}/requests/${r.id}/history`)).status, 200);
    assert.equal((await manager.get(`${API}/requests/${r.id}/history`)).status, 200);
  });

  test("the contact number is protected in list and detail responses", async () => {
    const r = await create("Contact must stay masked");
    const detail = await owner.get(`${API}/requests/${r.id}`);
    const list = await manager.get(`${API}/requests?search=contact%20must`);
    assert.equal(detail.body.contact, "0300-•••••67");
    for (const res of [detail, list]) assert.ok(!JSON.stringify(res.body).includes("03001234567"));
    assert.ok(!JSON.stringify(await record(r.id)).includes("03001234567"), "encrypted at rest");
  });

  test("EXAMINER: a forced history write failure leaves the transition fully undone", async () => {
    const r = await create("Transition rollback check");
    await breakHistory();
    let res;
    try {
      res = await manager.post(`${API}/requests/${r.id}/claim`, { version: 1 });
    } finally {
      await fixHistory();
    }
    assert.equal(res.status, 500);
    const now = await record(r.id);
    assert.equal(now.status, "Pending");
    assert.equal(now.version, 1);
    assert.equal(now.reviewer, null);
    assert.equal(await historyCount(r.id), 1);
  });
});

describe("Q3 D robust API", () => {
  test("invalid payloads, non-existent IDs and malformed IDs get clear errors", async () => {
    const manager = await person("Manager");
    assert.equal((await manager.post(`${API}/requests/SR-999999/claim`, { version: 1 })).status, 404);
    assert.equal((await manager.post(`${API}/requests/not-an-id/claim`, { version: 1 })).status, 400);
    assert.equal((await manager.post(`${API}/requests/SR-1000/claim`, { version: "1" })).status, 400);
    assert.equal((await manager.get(`${API}/requests/SR-999999`)).status, 404);
  });

  test("EXAMINER: with the database stopped, requests fail with 503 and nothing is saved", async () => {
    const owner = await person("Waiter");
    const client = await MongoClient.connect(ctx.uri, { serverSelectionTimeoutMS: 500 });
    const downApp = createApp({ config, db: client.db("cafems_test"), logger: createLogger(config) });
    await client.close();
    const down = browser(downApp);
    down.jar[SESSION_COOKIE] = owner.jar[SESSION_COOKIE];
    const res = await down.post(`${API}/requests`, body({ title: "Saved while database down" }), { csrf: "x" });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "database_unavailable");
    assert.equal(await db.collection("staff_requests").countDocuments({ title: "Saved while database down" }), 0);
  });
});
