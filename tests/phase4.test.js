// Phase 4 (Stock): suppliers, ingredient costs, purchase orders received in packs (unit conversion and
// weighted average cost), stocktakes, the waste log, and recipe cost and margin.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { seedCatalog } = require("../scripts/seed-data");
const { startDb, buildApp, createUser, signIn } = require("./helpers");

const API = "/api/v1";
let ctx, db, app, config, manager, admin, kitchen, barista, waiter, cashier;
async function as(role) {
  const user = await createUser(db, config, { role });
  return Object.assign(await signIn(app, db, user), { user });
}
const item = async (id) => db.collection("inventory").findOne({ _id: id });

before(async () => {
  ctx = await startDb();
  db = ctx.db;
  await seedCatalog(db);
  ({ app, config } = buildApp(db));
  [manager, admin, kitchen, barista, waiter, cashier] = await Promise.all(["Manager", "Admin", "Kitchen", "Barista", "Waiter", "Cashier"].map(as));
});
after(() => ctx.stop());

describe("suppliers and ingredients", () => {
  test("the starting data links each ingredient to a supplier record and gives it a cost", async () => {
    const suppliers = (await manager.get(`${API}/suppliers`)).body.suppliers;
    assert.ok(suppliers.some((s) => s.name === "Premier Dairy"));
    const milk = (await manager.get(`${API}/inventory`)).body.items.find((i) => i.name === "Milk");
    assert.equal(milk.cost, 220);
    assert.equal(milk.supplier, "Premier Dairy");
    assert.equal(milk.value, 18 * 220);
  });

  test("a manager adds a supplier and an ingredient; names must be unique", async () => {
    const sup = await manager.post(`${API}/suppliers`, { name: "Karachi Beans", phone: "021-111-222" });
    assert.equal(sup.status, 201, JSON.stringify(sup.body));
    assert.equal((await manager.post(`${API}/suppliers`, { name: "karachi beans" })).status, 409);
    const ing = await manager.post(`${API}/inventory`, { name: "Oat milk", unit: "L", reorder: 2, cost: 900, supplierId: sup.body.id });
    assert.equal(ing.status, 201, JSON.stringify(ing.body));
    assert.equal(ing.body.id, 17);
    assert.equal((await manager.post(`${API}/inventory`, { name: "Oat Milk", unit: "L", reorder: 2, cost: 900 })).status, 409);
  });

  test("a cost change is audited", async () => {
    const res = await manager.put(`${API}/inventory/3`, { reorder: 2, cost: 175, supplierId: "" });
    assert.equal(res.status, 200);
    assert.ok(await db.collection("audit_events").findOne({ action: "Ingredient cost changed", details: { $regex: "Sugar: Rs 160 to Rs 175" } }));
  });
});

describe("purchase orders", () => {
  test("bought in packs, received as stock: 3 × 1 kg bags of coffee add 3 kg and average the cost", async () => {
    const before = await item(1); // 4.2 kg at Rs 6,500
    const sup = (await manager.get(`${API}/suppliers`)).body.suppliers.find((s) => s.name === "Bean Roasters Co.");
    const po = await manager.post(`${API}/purchase-orders`, { supplierId: sup.id, lines: [{ ing: 1, packs: 3, packSize: 1, packCost: 7000 }] });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    assert.equal(po.body.total, 21000);
    assert.equal((await item(1)).qtyMilli, before.qtyMilli, "ordering does not change stock");

    const received = await manager.post(`${API}/purchase-orders/${po.body.id}/receive`, {});
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.status, "Received");
    const after = await item(1);
    assert.equal(after.qtyMilli, before.qtyMilli + 3000);
    // (4.2 × 6,500 + 3 × 7,000) / 7.2 = 6,708.33
    assert.equal(after.costPaisa, Math.round((4200 * 650000 + 3000 * 700000) / 7200));
    assert.equal((await manager.post(`${API}/purchase-orders/${po.body.id}/receive`, {})).status, 409, "received once");
  });

  test("a short delivery at a different price is received as it arrived", async () => {
    const before = await item(2); // milk, L
    const sup = (await manager.get(`${API}/suppliers`)).body.suppliers.find((s) => s.name === "Premier Dairy");
    const po = (await manager.post(`${API}/purchase-orders`, { supplierId: sup.id, lines: [{ ing: 2, packs: 10, packSize: 1.5, packCost: 300 }] })).body;
    const got = await manager.post(`${API}/purchase-orders/${po.id}/receive`, { lines: [{ ing: 2, packs: 8, packCost: 330 }] });
    assert.equal(got.status, 200);
    assert.equal(got.body.received[0].qty, 12);
    assert.equal(got.body.receivedTotal, 2640);
    assert.equal((await item(2)).qtyMilli, before.qtyMilli + 12000);
  });

  test("bad orders are refused, and a cancelled order cannot be received", async () => {
    const sup = (await manager.get(`${API}/suppliers`)).body.suppliers[0];
    assert.equal((await manager.post(`${API}/purchase-orders`, { supplierId: sup.id, lines: [{ ing: 999, packs: 1, packSize: 1, packCost: 1 }] })).status, 400);
    assert.equal((await manager.post(`${API}/purchase-orders`, { supplierId: sup.id, lines: [{ ing: 1, packs: 1, packSize: 1, packCost: 1 }, { ing: 1, packs: 1, packSize: 1, packCost: 1 }] })).status, 400);
    assert.equal((await manager.post(`${API}/purchase-orders`, { supplierId: "SUP-999", lines: [{ ing: 1, packs: 1, packSize: 1, packCost: 1 }] })).status, 400);
    const po = (await manager.post(`${API}/purchase-orders`, { supplierId: sup.id, lines: [{ ing: 3, packs: 1, packSize: 1, packCost: 200 }] })).body;
    assert.equal((await manager.post(`${API}/purchase-orders/${po.id}/cancel`, {})).status, 200);
    assert.equal((await manager.post(`${API}/purchase-orders/${po.id}/receive`, {})).status, 409);
  });
});

describe("stocktake", () => {
  test("counted amounts replace the system's figure, and the difference is valued", async () => {
    const before = await item(10); // potatoes, 9 kg at Rs 120
    const res = await manager.post(`${API}/stock-counts`, { counts: [{ ing: 10, counted: before.qtyMilli / 1000 - 1.5 }], note: "Weekly count" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.lines[0].diff, -1.5);
    assert.equal(res.body.lines[0].value, -180);
    assert.equal((await item(10)).qtyMilli, before.qtyMilli - 1500);
    assert.equal((await manager.get(`${API}/stock-counts`)).body.counts[0].id, res.body.id);
  });
});

describe("waste log", () => {
  test("the kitchen and bar log waste, which leaves stock and is valued at cost", async () => {
    const before = await item(2);
    const res = await barista.post(`${API}/waste`, { ing: 2, qty: 0.5, reason: "Milk went sour" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await item(2)).qtyMilli, before.qtyMilli - 500);
    assert.equal(res.body.value, Math.round(500 * before.costPaisa / 1000) / 100);
    assert.equal((await kitchen.post(`${API}/waste`, { ing: 2, qty: 100000 / 100, reason: "Too much" })).body.error.code, "stock_too_low");
    const list = (await manager.get(`${API}/waste`)).body.waste;
    assert.equal(list[0].reason, "Milk went sour");
    const choices = (await kitchen.get(`${API}/waste/choices`)).body.items;
    assert.ok(choices.length > 10);
    assert.doesNotMatch(JSON.stringify(choices), /cost|supplier|qty/i, "the kitchen sees names and units only");
  });

  test("waiters and cashiers cannot log waste; only managers change stock records", async () => {
    assert.equal((await waiter.post(`${API}/waste`, { ing: 2, qty: 1, reason: "Spilled" })).status, 403);
    assert.equal((await cashier.post(`${API}/waste`, { ing: 2, qty: 1, reason: "Spilled" })).status, 403);
    assert.equal((await kitchen.post(`${API}/purchase-orders`, { supplierId: "SUP-1", lines: [{ ing: 1, packs: 1, packSize: 1, packCost: 1 }] })).status, 403);
    assert.equal((await admin.post(`${API}/stock-counts`, { counts: [{ ing: 1, counted: 1 }] })).status, 403);
    assert.equal((await admin.get(`${API}/purchase-orders`)).status, 200, "an Admin can look");
  });
});

describe("recipe cost and margin", () => {
  test("each menu item shows what one portion costs and the margin on its price", async () => {
    const menu = (await admin.get(`${API}/menu`)).body.items;
    const latte = menu.find((m) => m.name === "Caffè Latte"); // 18 g coffee + 0.25 L milk
    const coffee = await item(1);
    const milk = await item(2);
    const expected = Math.round((18 * coffee.costPaisa) / 1000 + (250 * milk.costPaisa) / 1000) / 100;
    assert.equal(latte.cost, expected);
    assert.equal(latte.margin, Math.round(((latte.price - expected) / latte.price) * 1000) / 10);
    const waiterMenu = (await waiter.get(`${API}/menu`)).body.items;
    assert.equal(waiterMenu[0].cost, undefined, "costs stay with Admins");
  });
});
