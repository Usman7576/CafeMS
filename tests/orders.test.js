const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { startDb, buildApp, createUser, signIn } = require("./helpers");
const { seedCatalog, MENU } = require("../scripts/seed-data");
const { tickKitchen } = require("../server/services/kitchenSimulator");

let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

const API = "/api/v1";
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
const as = async (role) => signIn(app, db, await createUser(db, config, { role }));
const stockOf = async (id) => (await db.collection("inventory").findOne({ _id: id })).qtyMilli;

// Each test uses its own table, so tests do not block one another
let nextTable = 0;
const freeTable = async () => {
  nextTable += 1;
  await db.collection("orders").deleteMany({ table: ((nextTable - 1) % 10) + 1 });
  return ((nextTable - 1) % 10) + 1;
};
const place = (client, table, lines, extra = {}) => client.post(`${API}/orders`, { table, lines, ...extra }, key());

describe("prices and totals come from the server (finding 8)", () => {
  test("a price or total sent by the browser is refused", async () => {
    const waiter = await as("Waiter");
    const table = await freeTable();
    for (const body of [
      { table, lines: [{ id: 1, qty: 1, price: 1 }] },
      { table, lines: [{ id: 1, qty: 1 }], total: 1 },
      { table, lines: [{ id: 1, qty: 1 }], waiter: "someone.else" },
      { table, lines: [{ id: 1, qty: 1 }], status: "Served" }
    ]) {
      assert.equal((await waiter.post(`${API}/orders`, body, key())).status, 400);
    }
  });

  test("the order uses the stored price", async () => {
    const waiter = await as("Waiter");
    const res = await place(waiter, await freeTable(), [{ id: 1, qty: 2 }]);
    assert.equal(res.status, 201);
    assert.equal(res.body.items[0].price, MENU[0].price);
    assert.equal(res.body.totals.sub, MENU[0].price * 2);
  });

  test("negative, zero, fractional, huge and non-numeric quantities are refused", async () => {
    const waiter = await as("Waiter");
    const table = await freeTable();
    for (const qty of [-5, 0, 1.5, 100, 1e9, "2", null, { $gt: 0 }]) {
      assert.equal((await place(waiter, table, [{ id: 1, qty }])).status, 400, String(qty));
    }
    assert.equal(await db.collection("orders").countDocuments({ table }), 0);
  });

  test("repeated lines cannot get round the quantity limit", async () => {
    const waiter = await as("Waiter");
    assert.equal((await place(waiter, await freeTable(), [{ id: 1, qty: 99 }, { id: 1, qty: 99 }])).status, 400);
  });

  test("an unknown table or item is refused without crashing (findings 26, 27)", async () => {
    const waiter = await as("Waiter");
    assert.equal((await place(waiter, 99, [{ id: 1, qty: 1 }])).status, 400);
    assert.equal((await place(waiter, await freeTable(), [{ id: 9999, qty: 1 }])).status, 409);
  });
});

describe("stock (findings 23, 24)", () => {
  test("stock is checked for the full quantity, so it cannot be oversold", async () => {
    const waiter = await as("Waiter");
    await db.collection("inventory").updateOne({ _id: 14 }, { $set: { qtyMilli: 2000 } });
    const res = await place(waiter, await freeTable(), [{ id: 15, qty: 3 }]);
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /not enough stock/);
    assert.equal(await stockOf(14), 2000);
  });

  test("two lines sharing an ingredient are added up before checking", async () => {
    const waiter = await as("Waiter");
    await db.collection("inventory").updateOne({ _id: 1 }, { $set: { qtyMilli: 30 } });
    assert.equal((await place(waiter, await freeTable(), [{ id: 1, qty: 1 }, { id: 5, qty: 1 }])).status, 409);
    assert.equal(await stockOf(1), 30);
    await db.collection("inventory").updateOne({ _id: 1 }, { $set: { qtyMilli: 4200 } });
  });

  test("simultaneous orders cannot both take the last portion", async () => {
    await db.collection("inventory").updateOne({ _id: 14 }, { $set: { qtyMilli: 1000 } });
    const [a, b] = await Promise.all([as("Waiter"), as("Waiter")]);
    const [t1, t2] = [await freeTable(), await freeTable()];
    const results = await Promise.all([place(a, t1, [{ id: 15, qty: 1 }]), place(b, t2, [{ id: 15, qty: 1 }])]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await stockOf(14), 0);
    await db.collection("inventory").updateOne({ _id: 14 }, { $set: { qtyMilli: 18000 } });
  });

  test("cancelling returns exactly what was taken, even after a recipe change", async () => {
    const waiter = await as("Waiter");
    const before = await stockOf(2);
    const order = (await place(waiter, await freeTable(), [{ id: 2, qty: 3 }])).body;
    assert.equal(await stockOf(2), before - 450);
    await db.collection("menu").updateOne({ _id: 2 }, { $set: { "recipe.1.qtyMilli": 999 } });
    assert.equal((await waiter.post(`${API}/orders/${order.id}/cancel`, {})).status, 200);
    assert.equal(await stockOf(2), before);
    await db.collection("menu").updateOne({ _id: 2 }, { $set: { "recipe.1.qtyMilli": 150 } });
  });

  test("a failed edit changes neither stock nor the order (the transaction rolls back)", async () => {
    const waiter = await as("Waiter");
    const order = (await place(waiter, await freeTable(), [{ id: 15, qty: 1 }])).body;
    const before = await stockOf(14);
    const res = await waiter.put(`${API}/orders/${order.id}`, { version: order.version, lines: [{ id: 15, qty: 99 }] });
    assert.equal(res.status, 409);
    assert.equal(await stockOf(14), before);
    assert.equal((await db.collection("orders").findOne({ _id: order.id })).items[0].qty, 1);
  });
});

describe("ownership (findings 5, 6, 7)", () => {
  test("one waiter cannot see or change another waiter's order", async () => {
    const [owner, other] = [await as("Waiter"), await as("Waiter")];
    const order = (await place(owner, await freeTable(), [{ id: 1, qty: 1 }])).body;
    assert.equal((await other.put(`${API}/orders/${order.id}`, { version: 0, lines: [{ id: 1, qty: 5 }] })).status, 404);
    assert.equal((await other.post(`${API}/orders/${order.id}/cancel`, {})).status, 404);
    assert.equal((await other.post(`${API}/orders/${order.id}/serve`, {})).status, 404);
    assert.ok(!(await other.get(`${API}/orders`)).body.orders.some((o) => o.id === order.id));
  });

  test("a table held by one waiter cannot be taken by another", async () => {
    const [owner, other] = [await as("Waiter"), await as("Waiter")];
    const table = await freeTable();
    await place(owner, table, [{ id: 1, qty: 1 }]);
    assert.equal((await place(other, table, [{ id: 1, qty: 1 }])).body.error.code, "table_taken");
    const seen = (await other.get(`${API}/tables`)).body.tables.find((t) => t.no === table);
    assert.equal(seen.state, "other");
    assert.equal(seen.orderIds, undefined);
  });

  test("the recorded waiter is always the signed-in person", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    const order = (await place(client, await freeTable(), [{ id: 1, qty: 1 }])).body;
    assert.equal(order.waiter, user.username);
    assert.ok(await db.collection("audit_events").findOne({ actor: user.username, action: "Order placed" }));
  });

  test("only a waiter's own fully served table can request the bill", async () => {
    const [owner, other] = [await as("Waiter"), await as("Waiter")];
    const table = await freeTable();
    await place(owner, table, [{ id: 1, qty: 1 }]);
    assert.equal((await other.post(`${API}/tables/${table}/request-bill`, {})).status, 404);
    assert.equal((await owner.post(`${API}/tables/${table}/request-bill`, {})).body.error.code, "not_served");
  });
});

describe("kitchen", () => {
  test("the kitchen sees no prices or staff details, and follows the status order", async () => {
    const waiter = await as("Waiter");
    const kitchen = await as("Kitchen");
    const order = (await place(waiter, await freeTable(), [{ id: 1, qty: 1 }], { notes: "No sugar" })).body;

    const ticket = (await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.find((t) => t.id === order.id);
    assert.equal(ticket.notes, "No sugar");
    const raw = JSON.stringify(ticket);
    for (const hidden of ["price", "totals", "waiter", "stockUsed"]) assert.ok(!raw.includes(hidden), hidden);

    const STATUS = `${API}/kitchen/tickets/${order.id}/status`;
    assert.equal((await kitchen.post(STATUS, { status: "Ready" })).status, 409);
    assert.equal((await kitchen.post(STATUS, { status: "Served" })).status, 400);
    assert.equal((await kitchen.post(STATUS, { status: "Preparing" })).status, 200);
    assert.equal((await kitchen.post(STATUS, { status: "Ready" })).status, 200);
    assert.equal((await waiter.post(`${API}/orders/${order.id}/serve`, {})).status, 200);
    assert.equal((await waiter.post(`${API}/orders/${order.id}/serve`, {})).status, 409);
  });

  test("an order the kitchen has started can no longer be edited or cancelled", async () => {
    const waiter = await as("Waiter");
    const kitchen = await as("Kitchen");
    const order = (await place(waiter, await freeTable(), [{ id: 1, qty: 1 }])).body;
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
    assert.equal((await waiter.put(`${API}/orders/${order.id}`, { version: 0, lines: [{ id: 1, qty: 2 }] })).body.error.code, "kitchen_started");
    assert.equal((await waiter.post(`${API}/orders/${order.id}/cancel`, {})).status, 409);
  });

  test("the simulator is off by default and stands aside when kitchen staff are present", async () => {
    const waiter = await as("Waiter");
    const order = (await place(waiter, await freeTable(), [{ id: 1, qty: 1 }])).body;
    await db.collection("orders").updateOne({ _id: order.id }, { $set: { updatedAt: new Date(Date.now() - 60000) } });

    await db.collection("settings").deleteMany({});
    assert.equal(await tickKitchen(db), 0);

    await db.collection("settings").insertOne({ _id: "app", kitchenSim: true });
    assert.equal(await tickKitchen(db), 0, "kitchen staff signed in earlier in this test run");

    await db.collection("sessions").deleteMany({ role: "Kitchen" });
    assert.ok((await tickKitchen(db)) >= 1);
    assert.equal((await db.collection("orders").findOne({ _id: order.id })).status, "Preparing");
    await db.collection("settings").deleteMany({});
  });
});

describe("double submission and lost updates (findings 25, FMEA)", () => {
  test("an order needs an Idempotency-Key", async () => {
    const waiter = await as("Waiter");
    const res = await waiter.post(`${API}/orders`, { table: await freeTable(), lines: [{ id: 1, qty: 1 }] });
    assert.equal(res.body.error.code, "idempotency_key_required");
  });

  test("a double click creates one order and takes stock once", async () => {
    const waiter = await as("Waiter");
    const table = await freeTable();
    const before = await stockOf(1);
    const same = key();
    const body = { table, lines: [{ id: 1, qty: 1 }] };
    const [a, b] = await Promise.all([waiter.post(`${API}/orders`, body, same), waiter.post(`${API}/orders`, body, same)]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(a.body.id, b.body.id);
    assert.equal(await db.collection("orders").countDocuments({ table }), 1);
    assert.equal(await stockOf(1), before - 18);
  });

  test("reusing a key for a different request is refused", async () => {
    const waiter = await as("Waiter");
    const table = await freeTable();
    const same = key();
    await waiter.post(`${API}/orders`, { table, lines: [{ id: 1, qty: 1 }] }, same);
    const res = await waiter.post(`${API}/orders`, { table, lines: [{ id: 1, qty: 2 }] }, same);
    assert.equal(res.status, 422);
  });

  test("a key belongs to one person", async () => {
    const [a, b] = [await as("Waiter"), await as("Waiter")];
    const same = key();
    const first = await a.post(`${API}/orders`, { table: await freeTable(), lines: [{ id: 1, qty: 1 }] }, same);
    const second = await b.post(`${API}/orders`, { table: await freeTable(), lines: [{ id: 1, qty: 1 }] }, same);
    assert.notEqual(first.body.id, second.body.id);
    assert.equal(second.body.waiter !== first.body.waiter, true);
  });

  test("an edit from an out-of-date screen is refused rather than overwriting", async () => {
    const waiter = await as("Waiter");
    const order = (await place(waiter, await freeTable(), [{ id: 1, qty: 1 }])).body;
    assert.equal((await waiter.put(`${API}/orders/${order.id}`, { version: 0, lines: [{ id: 1, qty: 2 }] })).status, 200);
    assert.equal((await waiter.put(`${API}/orders/${order.id}`, { version: 0, lines: [{ id: 1, qty: 3 }] })).body.error.code, "stale_version");
  });
});
