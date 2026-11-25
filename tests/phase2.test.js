// Phase 2 (Sell): item options priced on the server, order types (dine-in, takeaway, delivery),
// hold and send, kitchen and bar stations, moving an order to another table, manager voids and
// paying for a counter order.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn, freshCode } = require("./helpers");
const { overallStatus } = require("../server/services/orders");

const API = "/api/v1";
let ctx, db, app, config, admin, waiter, waiter2, kitchen, barista, cashier, manager;
const key = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const stepUp = async (client) => assert.equal((await client.post(`${API}/auth/step-up`, { code: await freshCode(db, client.user) })).status, 204);
const place = (client, body) => client.post(`${API}/orders`, body, key());
const free = () => db.collection("orders").updateMany({ billed: false }, { $set: { billed: true } });
const stock = async (id) => (await db.collection("inventory").findOne({ _id: id })).qtyMilli;

// Cappuccino (2) gets a Size and a Milk choice
const OPTIONS = [
  { name: "Size", required: true, multi: false, choices: [{ name: "Regular", price: 0 }, { name: "Large", price: 120 }] },
  { name: "Extras", required: false, multi: true, choices: [{ name: "Oat milk", price: 80 }, { name: "Extra shot", price: 100 }] }
];

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  [admin, waiter, waiter2, kitchen, barista, cashier, manager] = await Promise.all(["Admin", "Waiter", "Waiter", "Kitchen", "Barista", "Cashier", "Manager"].map(as));
  const item = await db.collection("menu").findOne({ _id: 2 });
  const saved = await admin.put(`${API}/menu/2`, { name: item.name, cat: item.cat, price: item.price, desc: item.desc, available: true, options: OPTIONS });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // Drinks go to the bar
  await stepUp(admin);
  const current = (await admin.get(`${API}/settings`)).body;
  const body = { version: current.version, taxRatePct: current.taxRatePct, tables: current.tables, discountLimits: current.discountLimits, receipt: current.receipt, orderTypes: current.orderTypes,
    categories: current.categories.map((c) => ({ name: c.name, station: ["Coffee", "Tea", "Cold Drinks"].includes(c.name) ? "Bar" : "Kitchen" })) };
  assert.equal((await admin.put(`${API}/settings`, body)).status, 200);
});
after(() => ctx.stop());

describe("item options", () => {
  test("the price comes from the menu: a Large with oat milk is Rs 520 + 120 + 80", async () => {
    await free();
    const res = await place(waiter, { table: 1, lines: [{ id: 2, qty: 2, options: [{ group: "Size", choice: "Large" }, { group: "Extras", choice: "Oat milk" }] }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.items[0].price, 720);
    assert.deepEqual(res.body.items[0].options, ["Large", "Oat milk"]);
    assert.equal(res.body.totals.sub, 1440);
  });

  test("a required choice must be made, and only real choices are accepted", async () => {
    await free();
    const cases = [
      [[], /Choose a size/],
      [[{ group: "Size", choice: "Huge" }], /not an option/],
      [[{ group: "Size", choice: "Large" }, { group: "Size", choice: "Regular" }], /Choose one size/],
      [[{ group: "Size", choice: "Large" }, { group: "Extras", choice: "Oat milk" }, { group: "Extras", choice: "Oat milk" }], /twice/]
    ];
    for (const [options, message] of cases) {
      const res = await place(waiter, { table: 1, lines: [{ id: 2, qty: 1, options }] });
      assert.equal(res.status, 400, JSON.stringify(options));
      assert.match(res.body.error.message, message);
    }
    const priceTry = await place(waiter, { table: 1, lines: [{ id: 2, qty: 1, options: [{ group: "Size", choice: "Large" }], price: 1 }] });
    assert.equal(priceTry.status, 400, "a price from the browser is refused outright");
  });

  test("the same item with different options stays on separate lines; identical ones merge", async () => {
    await free();
    const large = [{ group: "Size", choice: "Large" }];
    const res = await place(waiter, { table: 1, lines: [{ id: 2, qty: 1, options: large }, { id: 2, qty: 1, options: [{ group: "Size", choice: "Regular" }] }, { id: 2, qty: 2, options: large }] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.items.map((i) => [i.options.join(), i.qty]).sort(), [["Large", 3], ["Regular", 1]]);
  });

  test("the menu refuses an unknown category and repeated option names", async () => {
    const base = { name: "Test Tea", cat: "Tea", price: 300, desc: "", available: true };
    assert.match((await admin.post(`${API}/menu`, { ...base, cat: "Nonsense" })).body.error.message, /category from the list/);
    const dup = await admin.post(`${API}/menu`, { ...base, options: [{ name: "Size", required: false, multi: false, choices: [{ name: "Big", price: 0 }, { name: "big", price: 10 }] }] });
    assert.match(dup.body.error.message, /own name/);
  });
});

describe("order types", () => {
  test("takeaway needs a name; delivery a mobile number and address; dine-in a table", async () => {
    const lines = [{ id: 1, qty: 1 }];
    assert.match((await place(cashier, { type: "takeaway", lines })).body.error.message, /customer's name/);
    assert.match((await place(cashier, { type: "delivery", customer: { name: "Ali Raza" }, lines })).body.error.message, /mobile number and an address/);
    assert.match((await place(waiter, { lines })).body.error.message, /Choose a table/);
    assert.match((await place(cashier, { type: "takeaway", table: 2, customer: { name: "Ali" }, lines })).body.error.message, /Only dine-in/);
  });

  test("delivery details are encrypted, and only the masked number is returned", async () => {
    const res = await place(cashier, { type: "delivery", customer: { name: "Ali Raza", phone: "03001234567", address: "House 4, Street 9, Lahore" }, lines: [{ id: 1, qty: 1 }] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.label, "Delivery · Ali Raza");
    assert.equal(res.body.customer.phone, "0300-•••••67");
    assert.equal(res.body.customer.address, "House 4, Street 9, Lahore");
    const raw = JSON.stringify(await db.collection("orders").findOne({ _id: res.body.id }));
    assert.ok(!raw.includes("03001234567") && !raw.includes("Street 9"), "stored encrypted");
    const ticket = (await barista.get(`${API}/kitchen/tickets`)).body.tickets.find((t) => t.id === res.body.id);
    assert.equal(ticket.label, "Delivery · Ali");
    assert.doesNotMatch(JSON.stringify(ticket), /0300|Street|price/i, "the bar sees no contact details or prices");
  });

  test("a type switched off in Settings is refused", async () => {
    await stepUp(admin);
    const s = (await admin.get(`${API}/settings`)).body;
    const body = { version: s.version, taxRatePct: s.taxRatePct, tables: s.tables, discountLimits: s.discountLimits, receipt: s.receipt, categories: s.categories, orderTypes: { ...s.orderTypes, delivery: false } };
    assert.equal((await admin.put(`${API}/settings`, body)).status, 200);
    const res = await place(cashier, { type: "delivery", customer: { name: "Ali Raza", phone: "03001234567", address: "House 4, Street 9" }, lines: [{ id: 1, qty: 1 }] });
    assert.match(res.body.error.message, /switched off/);
    assert.equal((await admin.put(`${API}/settings`, { ...body, version: body.version + 1, orderTypes: s.orderTypes })).status, 200);
  });
});

describe("hold and send", () => {
  test("a held order is not shown to the stations, can be changed, and is sent later", async () => {
    await free();
    const held = (await place(waiter, { table: 3, lines: [{ id: 10, qty: 1 }], hold: true })).body;
    assert.equal(held.status, "Held");
    assert.ok(!(await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === held.id));
    const changed = await waiter.put(`${API}/orders/${held.id}`, { version: held.version, lines: [{ id: 10, qty: 2 }] });
    assert.equal(changed.status, 200);
    assert.equal((await waiter.post(`${API}/orders/${held.id}/send`, {})).body.status, "Placed");
    assert.ok((await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === held.id));
    assert.equal((await waiter.post(`${API}/orders/${held.id}/send`, {})).status, 409, "sent only once");
  });

  test("a held order stops the table from being billed, and cancelling it returns the stock", async () => {
    await free();
    const before = await stock(8);
    const held = (await place(waiter, { table: 4, lines: [{ id: 10, qty: 1 }], hold: true })).body;
    assert.ok(await stock(8) < before);
    assert.equal((await cashier.post(`${API}/billing/tables/4/pay`, { method: "Card" }, key())).body.error.code, "not_served");
    assert.equal((await waiter.post(`${API}/orders/${held.id}/cancel`, {})).status, 200);
    assert.equal(await stock(8), before);
  });
});

describe("kitchen and bar stations", () => {
  test("each station sees and moves only its own items; the order is ready when both are", async () => {
    await free();
    const order = (await place(waiter, { table: 5, lines: [{ id: 1, qty: 1 }, { id: 10, qty: 1 }] })).body;
    assert.deepEqual(order.stations, { Bar: "Placed", Kitchen: "Placed" });
    const k = (await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.find((t) => t.id === order.id);
    const b = (await barista.get(`${API}/kitchen/tickets`)).body.tickets.find((t) => t.id === order.id);
    assert.deepEqual(k.items.map((i) => i.name), ["Chicken Club Sandwich"]);
    assert.deepEqual(b.items.map((i) => i.name), ["Espresso"]);

    const move = (client, status) => client.post(`${API}/kitchen/tickets/${order.id}/status`, { status });
    assert.equal((await move(barista, "Preparing")).status, 200);
    assert.equal((await waiter.get(`${API}/orders`)).body.orders.find((o) => o.id === order.id).status, "Preparing");
    assert.equal((await move(barista, "Ready")).status, 200);
    assert.equal((await waiter.get(`${API}/orders`)).body.orders.find((o) => o.id === order.id).status, "Preparing", "the kitchen part is not ready yet");
    assert.equal((await move(barista, "Ready")).status, 409, "the bar cannot move its part twice");
    await move(kitchen, "Preparing");
    await move(kitchen, "Ready");
    assert.equal((await waiter.get(`${API}/orders`)).body.orders.find((o) => o.id === order.id).status, "Ready");
  });

  test("a station without items on an order cannot touch it", async () => {
    await free();
    const order = (await place(waiter, { table: 6, lines: [{ id: 1, qty: 1 }] })).body;
    assert.equal((await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" })).status, 404);
  });

  test("the overall status follows the stations", () => {
    assert.equal(overallStatus({ Kitchen: "Placed", Bar: "Placed" }), "Placed");
    assert.equal(overallStatus({ Kitchen: "Placed", Bar: "Ready" }), "Preparing");
    assert.equal(overallStatus({ Kitchen: "Ready", Bar: "Ready" }), "Ready");
  });

  test("orders saved before stations existed still reach the kitchen", async () => {
    await db.collection("orders").insertOne({ _id: "ORD-999999", table: 7, items: [{ id: 1, name: "Espresso", price: 350, qty: 1 }], status: "Placed", waiter: waiter.user.username, billed: false, createdAt: new Date(), updatedAt: new Date(), version: 0 });
    assert.ok((await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === "ORD-999999"));
    assert.equal((await kitchen.post(`${API}/kitchen/tickets/ORD-999999/status`, { status: "Preparing" })).status, 200);
    await db.collection("orders").deleteOne({ _id: "ORD-999999" });
  });
});

describe("moving an order to another table", () => {
  test("to a free table works; to someone else's table, or another person's order, does not", async () => {
    await free();
    const mine = (await place(waiter, { table: 1, lines: [{ id: 10, qty: 1 }] })).body;
    const theirs = (await place(waiter2, { table: 2, lines: [{ id: 10, qty: 1 }] })).body;
    const moved = await waiter.post(`${API}/orders/${mine.id}/transfer`, { table: 3 });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.table, 3);
    assert.equal((await waiter.post(`${API}/orders/${mine.id}/transfer`, { table: 2 })).body.error.code, "table_taken");
    assert.equal((await waiter.post(`${API}/orders/${theirs.id}/transfer`, { table: 4 })).status, 404);
    assert.equal((await waiter.post(`${API}/orders/${mine.id}/transfer`, { table: 999 })).status, 400);
    assert.ok(await db.collection("audit_events").findOne({ action: "Order moved", details: { $regex: `${mine.id} · Table 1 to Table 3` } }));
  });
});

describe("voids", () => {
  test("only a manager, after a fresh code, voids a started order; its stock is counted as used", async () => {
    await free();
    const order = (await place(waiter, { table: 8, lines: [{ id: 10, qty: 1 }] })).body;
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
    assert.equal((await waiter.post(`${API}/orders/${order.id}/cancel`, {})).status, 409, "too late to cancel");
    assert.equal((await waiter.post(`${API}/orders/${order.id}/void`, { reason: "Guest left" })).status, 403);
    assert.equal((await manager.post(`${API}/orders/${order.id}/void`, { reason: "Guest left" })).body.error.code, "step_up_required");
    await stepUp(manager);
    const used = await stock(8);
    const res = await manager.post(`${API}/orders/${order.id}/void`, { reason: "Guest left" });
    assert.equal(res.status, 200);
    assert.equal(res.body.stockReturned, false);
    assert.equal(await stock(8), used);
    assert.ok(!(await kitchen.get(`${API}/kitchen/tickets`)).body.tickets.some((t) => t.id === order.id));
    const event = await db.collection("audit_events").findOne({ action: "Order voided" });
    assert.match(event.details, /Guest left/);
    assert.equal(event.severity, "high");
  });
});

describe("a counter order from start to payment", () => {
  test("a cashier takes a takeaway order, hands it over and bills it on its own", async () => {
    const order = (await place(cashier, { type: "takeaway", customer: { name: "Sana" }, lines: [{ id: 10, qty: 1 }] })).body;
    assert.equal(order.label, "Takeaway · Sana");
    const tab = (await cashier.get(`${API}/billing/open-tables`)).body.tables.find((t) => t.key === order.id);
    assert.equal(tab.label, "Takeaway · Sana");
    assert.equal((await cashier.post(`${API}/billing/orders/${order.id}/pay`, { method: "Card" }, key())).body.error.code, "not_served");
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Preparing" });
    await kitchen.post(`${API}/kitchen/tickets/${order.id}/status`, { status: "Ready" });
    assert.equal((await cashier.post(`${API}/orders/${order.id}/serve`, {})).status, 200);
    const bill = await cashier.post(`${API}/billing/orders/${order.id}/pay`, { method: "Cash", tendered: 2000 }, key());
    assert.equal(bill.status, 201, JSON.stringify(bill.body));
    assert.equal(bill.body.label, "Takeaway · Sana");
    assert.equal(bill.body.type, "takeaway");
    assert.equal((await cashier.post(`${API}/billing/orders/${order.id}/pay`, { method: "Cash", tendered: 2000 }, key())).status, 404, "billed once");
  });
});
