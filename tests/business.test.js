const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");
const { startDb, buildApp, browser, createUser, signIn, freshCode } = require("./helpers");
const { seedCatalog } = require("../scripts/seed-data");
const { localDate } = require("../server/lib/domain");

let ctx, db, app, config;
const clients = {};
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  for (const role of ["Waiter", "Kitchen", "Cashier", "Manager", "Admin"]) clients[role] = await as(role);
});
after(() => ctx.stop());

const API = "/api/v1";
const PHONE = "03211234567";
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  const client = await signIn(app, db, user);
  client.user = user;
  return client;
}
async function stepUp(client) {
  assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
}

describe("every role against every route (RBAC matrix)", () => {
  const ALL = ["Waiter", "Kitchen", "Cashier", "Manager", "Admin"];
  const MATRIX = [
    ["get", "/menu", ["Waiter", "Admin"]],
    ["post", "/menu", ["Admin"]],
    ["put", "/menu/999999", ["Admin"]],
    ["delete", "/menu/999999", ["Admin"]],
    ["get", "/inventory", ["Manager", "Admin"]],
    ["post", "/inventory/1/adjust", ["Manager"]],
    ["get", "/orders", ["Waiter"]],
    ["post", "/orders", ["Waiter"]],
    ["put", "/orders/ORD-1", ["Waiter"]],
    ["post", "/orders/ORD-1/serve", ["Waiter"]],
    ["post", "/orders/ORD-1/cancel", ["Waiter"]],
    ["get", "/tables", ["Waiter"]],
    ["post", "/tables/1/request-bill", ["Waiter"]],
    ["get", "/kitchen/tickets", ["Kitchen"]],
    ["post", "/kitchen/tickets/ORD-1/status", ["Kitchen"]],
    ["get", "/billing/open-tables", ["Cashier", "Manager"]],
    ["post", "/billing/tables/1/pay", ["Cashier", "Manager"]],
    ["get", "/bills", ["Cashier", "Manager", "Admin"]],
    ["get", "/bills/B-1", ["Cashier", "Manager", "Admin"]],
    ["get", "/bills/B-1/phone", ["Manager", "Admin"]],
    ["post", "/bills/B-1/refund", ["Manager"]],
    ["get", "/approvals", ["Manager", "Admin"]],
    ["post", "/approvals/aaaaaaaaaaaaaaaaaaaaaaaa/approve", ["Manager", "Admin"]],
    ["post", "/approvals/aaaaaaaaaaaaaaaaaaaaaaaa/reject", ["Manager", "Admin"]],
    ["get", "/reservations", ["Waiter", "Manager"]],
    ["post", "/reservations", ["Waiter", "Manager"]],
    ["post", "/reservations/search", ["Waiter", "Manager"]],
    ["post", "/reservations/R-1/status", ["Waiter", "Manager"]],
    ["get", "/reservations/R-1/phone", ["Manager", "Admin"]],
    ["get", "/reports/sales", ["Manager", "Admin"]],
    ["get", "/reports/sales.csv", ["Manager", "Admin"]],
    ["get", "/audit", ["Admin"]],
    ["get", "/audit/verify", ["Admin"]],
    ["get", "/audit/public-keys", ["Admin"]],
    ["get", "/alerts", ["Admin"]],
    ["post", "/alerts/aaaaaaaaaaaaaaaaaaaaaaaa/acknowledge", ["Admin"]],
    ["post", "/customers/erase", ["Admin"]],
    ["put", "/menu/999999/photo", ["Admin"]],
    ["post", "/bills/B-1/retry-payment", ["Cashier", "Manager"]],
    ["get", "/audit.csv", ["Admin"]],
    ["put", "/settings/cafe", ["Admin"]],
    ["get", "/reports/trend", ["Manager", "Admin"]],
    ["get", "/users", ["Admin"]],
    ["post", "/users/invitations", ["Admin"]],
    ["post", "/users/some.user/role", ["Admin"]],
    ["post", "/users/some.user/status", ["Admin"]],
    ["post", "/users/some.user/reset-link", ["Admin"]],
    ["post", "/users/some.user/unlock", ["Admin"]]
  ];

  for (const [method, path, allowed] of MATRIX) {
    test(`${method.toUpperCase()} ${path}`, async () => {
      const call = (client) => (method === "post" || method === "put" ? client[method](`${API}${path}`, {}) : client[method](`${API}${path}`));
      assert.equal((await call(browser(app))).status, 401, "no session");
      for (const role of ALL) {
        const res = await call(clients[role]);
        // "Confirm your code first" means the role is allowed but must prove it is still them
        const denied = res.status === 403 && res.body.error.code === "forbidden";
        assert.equal(denied, !allowed.includes(role), `${role}: got ${res.status} ${res.body.error ? res.body.error.code : ""}`);
      }
    });
  }
});

describe("what each role receives (least privilege)", () => {
  const keysOf = async (role) => Object.keys((await clients[role].get(`${API}/snapshot`)).body).sort();

  test("the snapshot holds only that role's data", async () => {
    assert.deepEqual(await keysOf("Kitchen"), ["cafe", "constants", "tickets"]);
    assert.deepEqual(await keysOf("Waiter"), ["cafe", "constants", "menu", "orders", "reservations", "tables"]);
    assert.deepEqual(await keysOf("Cashier"), ["bills", "cafe", "constants", "openTables", "staffNames"]);
    assert.deepEqual(await keysOf("Manager"), ["approvals", "bills", "cafe", "constants", "inventory", "openTables", "reservations", "sales", "staffNames"]);
    assert.deepEqual(await keysOf("Admin"), ["alerts", "approvals", "bills", "cafe", "constants", "inventory", "menu", "openTables", "recentAudit", "sales", "staffNames", "users"]);
  });

  test("no response holds password hashes, MFA secrets or session data", async () => {
    for (const role of Object.keys(clients)) {
      const raw = JSON.stringify((await clients[role].get(`${API}/snapshot`)).body);
      for (const secret of ["passwordHash", "$argon2", "secretEnc", "recoveryHashes", "csrfToken", "jti", "phoneEnc", "phoneIndex"]) {
        assert.ok(!raw.includes(secret), `${role}: ${secret}`);
      }
    }
    const raw = JSON.stringify((await clients.Admin.get(`${API}/users`)).body);
    assert.ok(!raw.includes("passwordHash") && !raw.includes("secretEnc"));
  });

  test("waiters do not see recipes or stock levels", async () => {
    const raw = JSON.stringify((await clients.Waiter.get(`${API}/menu`)).body);
    assert.ok(!raw.includes("recipe") && !raw.includes("qtyMilli"));
  });
});

describe("menu", () => {
  const ITEM = { name: "Test Cookie", cat: "Desserts", price: 200, desc: "Crisp", available: true };

  test("validates input with clear messages", async () => {
    const admin = clients.Admin;
    const bad = async (body) => (await admin.post(`${API}/menu`, { ...ITEM, ...body })).body.error;
    assert.match((await bad({ price: 1 })).message, /between Rs 50/);
    assert.match((await bad({ price: 99.5 })).message, /whole number/);
    assert.match((await bad({ name: "x" })).message, /2-40/);
    assert.equal((await bad({ recipe: [] })).code, "invalid_input");
    assert.equal((await bad({ _id: 1 })).code, "invalid_input");
    assert.equal((await bad({ name: { $gt: "" } })).code, "invalid_input");
  });

  test("add, change price with an audit entry, then delete", async () => {
    const admin = clients.Admin;
    const created = await admin.post(`${API}/menu`, ITEM);
    assert.equal(created.status, 201);
    const { id } = created.body;
    assert.equal((await admin.post(`${API}/menu`, ITEM)).body.error.code, "name_taken");
    assert.equal((await admin.put(`${API}/menu/${id}`, { ...ITEM, price: 250 })).status, 200);
    const event = await db.collection("audit_events").findOne({ action: "Price changed", details: /Test Cookie/ });
    assert.match(event.details, /200 to Rs 250/);
    assert.equal((await admin.delete(`${API}/menu/${id}`)).status, 204);
  });

  test("regex characters in a name cannot cause errors or false matches", async () => {
    const res = await clients.Admin.post(`${API}/menu`, { ...ITEM, name: "Cake (.*)" });
    assert.equal(res.status, 201);
    assert.equal((await clients.Admin.delete(`${API}/menu/${res.body.id}`)).status, 204);
  });

  test("an unknown item gives 404, not a crash (finding 27)", async () => {
    assert.equal((await clients.Admin.put(`${API}/menu/99999`, ITEM)).status, 404);
    assert.equal((await clients.Admin.delete(`${API}/menu/99999`)).status, 404);
  });

  test("an item on an open order cannot be deleted", async () => {
    const created = (await clients.Admin.post(`${API}/menu`, { ...ITEM, name: "On Order" })).body;
    await db.collection("orders").deleteMany({ table: 5 });
    await clients.Waiter.post(`${API}/orders`, { table: 5, lines: [{ id: created.id, qty: 1 }] }, key());
    assert.equal((await clients.Admin.delete(`${API}/menu/${created.id}`)).body.error.code, "item_in_use");
  });
});

describe("inventory", () => {
  test("restock and write-off are exact, recorded and cannot go below zero", async () => {
    const manager = clients.Manager;
    const ADJUST = `${API}/inventory/3/adjust`;
    const before = (await db.collection("inventory").findOne({ _id: 3 })).qtyMilli;
    assert.equal((await manager.post(ADJUST, { delta: 0.1, reason: "Delivery" })).status, 200);
    assert.equal((await manager.post(ADJUST, { delta: 0.2, reason: "Delivery" })).status, 200);
    assert.equal((await db.collection("inventory").findOne({ _id: 3 })).qtyMilli, before + 300);
    assert.equal((await manager.post(ADJUST, { delta: -100000, reason: "Spilt" })).status, 400);
    assert.equal((await manager.post(ADJUST, { delta: -999, reason: "Spilt" })).body.error.code, "stock_too_low");
    assert.equal((await manager.post(ADJUST, { delta: 1, reason: "" })).status, 400);
    assert.equal((await manager.post(`${API}/inventory/999/adjust`, { delta: 1, reason: "Delivery" })).status, 404);
  });
});

describe("reservations", () => {
  const futureDate = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  let counter = 0;
  const booking = (extra = {}) => ({ name: "Ayesha Khan", phone: PHONE, date: futureDate(), time: `1${(counter += 1) % 9}:00`, party: 4, notes: "Window seat", ...extra });
  const post = (client, body) => client.post(`${API}/reservations`, body, key());

  test("name, phone and notes are encrypted at rest", async () => {
    const res = await post(clients.Waiter, booking());
    assert.equal(res.status, 201);
    assert.equal(res.body.name, "Ayesha Khan");
    const stored = JSON.stringify(await db.collection("reservations").findOne({ _id: res.body.id }));
    for (const plain of ["Ayesha", PHONE, "Window seat"]) assert.ok(!stored.includes(plain), plain);
  });

  test("waiters see a masked phone; only a Manager or Admin can reveal it, with a log entry (finding 32)", async () => {
    const res = await post(clients.Waiter, booking());
    assert.equal(res.body.phone, "0321-•••••67");
    assert.ok(!JSON.stringify((await clients.Waiter.get(`${API}/reservations`)).body).includes(PHONE));
    assert.equal((await clients.Waiter.get(`${API}/reservations/${res.body.id}/phone`)).status, 403);
    assert.equal((await clients.Manager.get(`${API}/reservations/${res.body.id}/phone`)).body.phone, PHONE);
    assert.ok(await db.collection("audit_events").findOne({ action: "Customer phone viewed", details: res.body.id }));
  });

  test("audit entries do not contain guest names", async () => {
    const res = await post(clients.Waiter, booking({ name: "Private Person" }));
    const event = await db.collection("audit_events").findOne({ action: "Reservation created", details: new RegExp(res.body.id) });
    assert.ok(!event.details.includes("Private"));
  });

  test("search works by exact phone number without decrypting everything", async () => {
    const other = "03457654321";
    const res = await post(clients.Waiter, booking({ phone: other }));
    const found = (await clients.Waiter.post(`${API}/reservations/search`, { phone: other })).body.reservations;
    assert.deepEqual(found.map((r) => r.id), [res.body.id]);
  });

  test("validates each field", async () => {
    const message = async (extra) => (await post(clients.Waiter, booking(extra))).body.error.message;
    assert.match(await message({ name: "A" }), /2-60/);
    assert.match(await message({ phone: "123" }), /03XXXXXXXXX/);
    assert.match(await message({ date: "2020-01-01" }), /past date/);
    assert.match(await message({ date: "2099-02-31" }), /valid reservation date/);
    assert.match(await message({ time: "09:00" }), /between 10:00 and 23:00/);
    assert.match(await message({ time: "23:30" }), /between 10:00 and 23:00/);
    assert.match(await message({ party: 21 }), /1 to 20/);
    assert.match(await message({ notes: "x".repeat(161) }), /160/);
  });

  test("today is allowed", async () => {
    assert.equal((await post(clients.Waiter, booking({ date: localDate(), time: "22:00", phone: "03001112223" }))).status, 201);
  });

  test("duplicates are refused, even when submitted at the same moment", async () => {
    const body = booking({ phone: "03331112222", time: "20:00" });
    const results = await Promise.all([post(clients.Waiter, body), post(clients.Manager, body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });

  test("a cancelled booking frees the slot, and closed bookings cannot change", async () => {
    const body = booking({ phone: "03331113333", time: "21:00" });
    const { id } = (await post(clients.Waiter, body)).body;
    const STATUS = `${API}/reservations/${id}/status`;
    assert.equal((await clients.Waiter.post(STATUS, { status: "Bogus" })).status, 400);
    assert.equal((await clients.Waiter.post(STATUS, { status: "Confirmed" })).body.error.code, "same_status");
    assert.equal((await clients.Waiter.post(STATUS, { status: "Cancelled" })).status, 200);
    assert.equal((await clients.Waiter.post(STATUS, { status: "Seated" })).body.error.code, "closed");
    assert.equal((await post(clients.Waiter, body)).status, 201);
  });
});

describe("audit log access", () => {
  test("filters and limits work, and bad input is refused", async () => {
    const admin = clients.Admin;
    const res = await admin.get(`${API}/audit?severity=warning&limit=5`);
    assert.ok(res.body.entries.length <= 5);
    assert.ok(res.body.entries.every((e) => e.severity === "warning"));
    assert.equal((await admin.get(`${API}/audit?limit=100000`)).status, 400);
    assert.equal((await admin.get(`${API}/audit?severity[$ne]=info`)).status, 400);
  });

  test("there is no route to change or delete audit entries", async () => {
    const admin = clients.Admin;
    assert.equal((await admin.delete(`${API}/audit`)).status, 404);
    assert.equal((await admin.put(`${API}/audit`, {})).status, 404);
    assert.equal((await admin.post(`${API}/audit`, { action: "Fake" })).status, 404);
  });
});

describe("settings (finding 16) and removed reset (finding 10)", () => {
  test("only the allowed cafe details can be written; __proto__ and others are refused", async () => {
    const admin = clients.Admin;
    const details = { name: "Test Cafe", tagline: "Hello", about: "About us", address: "1 Main Road", phone: "0300-1234567", hours: "Daily" };
    assert.equal((await admin.put(`${API}/settings/cafe`, details)).status, 200);
    assert.equal((await admin.put(`${API}/settings/cafe`, { ...details, other: 1 })).status, 400);
    assert.equal((await admin.put(`${API}/settings/cafe`, { ...details, name: { $ne: "" } })).status, 400);
    assert.equal((await admin.put(`${API}/settings/cafe`, { ...details, phone: "<script>" })).status, 400);
    const res = await request(app).put(`${API}/settings/cafe`).set("Origin", "http://localhost:3000").set("Content-Type", "application/json").send('{"__proto__":{"polluted":true}}');
    assert.equal(res.status, 401);
    assert.equal({}.polluted, undefined);
    assert.ok(await db.collection("audit_events").findOne({ action: "Cafe details changed" }));
  });

  test("no route can wipe the data", async () => {
    for (const path of ["/reset", "/state", "/demo/reset"]) {
      assert.equal((await clients.Admin.post(`${API}${path}`, {})).status, 404);
    }
  });
});

describe("staff administration", () => {
  test("changing a role needs a fresh code and ends that person's sessions", async () => {
    const admin = await as("Admin");
    const target = await as("Waiter");
    const ROLE = `${API}/users/${target.user.username}/role`;
    assert.equal((await admin.post(ROLE, { role: "Cashier" })).body.error.code, "step_up_required");
    await stepUp(admin);
    assert.equal((await admin.post(ROLE, { role: "Cashier" })).status, 200);
    assert.equal((await target.get(`${API}/auth/me`)).status, 401);
  });

  test("disabling ends sessions at once", async () => {
    const admin = await as("Admin");
    const target = await as("Cashier");
    await stepUp(admin);
    assert.equal((await admin.post(`${API}/users/${target.user.username}/status`, { status: "Disabled" })).status, 200);
    assert.equal((await target.get(`${API}/bills`)).status, 401);
  });

  test("nobody can change their own role or status", async () => {
    const admin = await as("Admin");
    await stepUp(admin);
    assert.equal((await admin.post(`${API}/users/${admin.user.username}/role`, { role: "Waiter" })).body.error.code, "own_account");
    assert.equal((await admin.post(`${API}/users/${admin.user.username}/status`, { status: "Disabled" })).body.error.code, "own_account");
  });

  test("any change that affects an Admin needs a second Admin", async () => {
    const [a, b] = [await as("Admin"), await as("Admin")];
    const target = await as("Admin");
    await stepUp(a);
    for (const [path, body] of [["role", { role: "Waiter" }], ["status", { status: "Disabled" }], ["reset-link", {}]]) {
      const res = await a.post(`${API}/users/${target.user.username}/${path}`, body);
      assert.equal(res.status, 202, path);
    }
    const promote = await as("Waiter");
    assert.equal((await a.post(`${API}/users/${promote.user.username}/role`, { role: "Admin" })).status, 202);
    assert.equal((await db.collection("users").findOne({ username: promote.user.username })).role, "Waiter");
    assert.equal((await db.collection("users").findOne({ username: target.user.username })).role, "Admin");
    assert.ok((await b.get(`${API}/approvals`)).body.approvals.length >= 4);
  });

  test("the target of a request cannot approve it", async () => {
    const [a, target] = [await as("Admin"), await as("Admin")];
    await stepUp(a);
    const { approvalId } = (await a.post(`${API}/users/${target.user.username}/role`, { role: "Waiter" })).body;
    await stepUp(target);
    assert.equal((await target.post(`${API}/approvals/${approvalId}/approve`, {})).body.error.code, "same_person");
  });

  test("two Admins alone cannot remove each other: nobody is left to approve", async () => {
    const [a, target] = [await as("Admin"), await as("Admin")];
    await stepUp(a);
    const { approvalId } = (await a.post(`${API}/users/${target.user.username}/status`, { status: "Disabled" })).body;
    await stepUp(a);
    await stepUp(target);
    assert.equal((await a.post(`${API}/approvals/${approvalId}/approve`, {})).body.error.code, "same_person");
    assert.equal((await target.post(`${API}/approvals/${approvalId}/approve`, {})).body.error.code, "same_person");
    assert.equal((await db.collection("users").findOne({ username: target.user.username })).status, "Active");
  });

  test("the last active Admin cannot be removed, even if a request gets through", async () => {
    const { createUserService } = require("../server/services/users");
    const service = createUserService({ config, db, approvals: null });
    const target = await createUser(db, config, { role: "Admin" });
    const others = await db.collection("users").find({ role: "Admin", status: "Active", username: { $ne: target.username } }).toArray();
    await db.collection("users").updateMany({ username: { $in: others.map((u) => u.username) } }, { $set: { status: "Disabled" } });
    const req = { auth: { user: { username: "system.test", role: "Admin" } } };
    await assert.rejects(service.execute(req, { action: "status", target: target.username, status: "Disabled" }), (e) => e.code === "last_admin");
    await assert.rejects(service.execute(req, { action: "role", target: target.username, role: "Waiter" }), (e) => e.code === "last_admin");
    await db.collection("users").updateMany({ username: { $in: others.map((u) => u.username) } }, { $set: { status: "Active" } });
  });
});
