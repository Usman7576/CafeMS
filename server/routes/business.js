// Business API. Each route states its permission; ownership and business rules live in the services.
const express = require("express");
const path = require("path");
const schemas = require("../lib/schemas");
const { ACTIVE_ORDER_STATUSES } = require("../lib/domain");
const { AppError } = require("../lib/errors");
const { can } = require("../lib/permissions");
const { toCsv } = require("../lib/csv");
const { inTransaction, idempotentTransaction } = require("../lib/tx");
const { validate } = require("../middleware/auth");
const { recordEvent, verifyChain, publicKeys } = require("../services/auditLog");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const params = (schema) => validate(schema, "params");

const VIEW_RECORD_MS = 60 * 60 * 1000;
const MAX_VIEW_KEYS = 5000;

function createBusinessRouter({ db, middleware, services, personalLimiter, photoLimit, appOrigin, authLimiter }) {
  const router = express.Router();
  const { requireAuth, requirePermission, requireStepUp } = middleware;
  // Opening customer records is recorded, but screens refresh every few seconds, so the same view by the
  // same person is written once an hour. Opening many different records still adds up to an alert.
  const viewed = new Map();
  async function recordView(req, action, what, details) {
    const { username, role } = req.auth.user;
    const key = `${username}|${action}|${what}`;
    const now = Date.now();
    if (viewed.get(key) > now - VIEW_RECORD_MS) return;
    await recordEvent(db, req, { actor: username, role, action, details, severity: "info" });
    if (viewed.size >= MAX_VIEW_KEYS) viewed.clear();
    viewed.set(key, now);
  }
  async function viewedList(req, what, label, load) {
    const records = await load();
    await recordView(req, "Customer records viewed", `${what}:{}`, `${label} · ${records.length} records`);
    return records;
  }

  const { catalog, orderService, billing, reservations, approvals, userService, alerts, customers, photos, cafe, publicCache, staffRequests, settings, events, sessions, shiftService, purchasing, guests, people, insights } = services;
  // Any successful staff change clears the public website's short cache, so an edit shows at once
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") res.on("finish", () => { if (res.statusCode < 400) publicCache.clear(); });
    next();
  });
  const allow = (permission) => [requireAuth, requirePermission(permission)];

  const tx = (work) => wrap(async (req, res) => res.json(await inTransaction(db, (session) => work(req, session))));
  const once = (work, status = 200) => wrap(async (req, res) => {
    const outcome = await idempotentTransaction(db, req, async (session) => ({ status, body: await work(req, session) }));
    res.status(outcome.status).json(outcome.body);
  });
  const numericId = (req) => Number(req.validParams.id);
  const tableNumber = (req) => {
    const no = Number(req.validParams.no);
    if (!settings.hasTable(no)) throw new AppError(404, "not_found", "Table not found.");
    return no;
  };

  // ---------- Menu ----------
  router.get("/menu", ...allow("menu.read"), wrap(async (req, res) => {
    res.json({ items: can(req.auth.user.role, "menu.write") ? await catalog.listForAdmin() : await catalog.listForSale() });
  }));
  router.post("/menu", ...allow("menu.write"), validate(schemas.menuItem), wrap(async (req, res) => {
    const id = await inTransaction(db, (session) => catalog.saveItem(req, null, req.body, session));
    res.status(201).json({ id });
  }));
  router.put("/menu/:id", ...allow("menu.write"), params(schemas.params.numericId), validate(schemas.menuItem), tx(async (req, session) => ({ id: await catalog.saveItem(req, numericId(req), req.body, session) })));
  router.delete("/menu/:id", ...allow("menu.write"), params(schemas.params.numericId), wrap(async (req, res) => {
    const photo = await inTransaction(db, (session) => catalog.deleteItem(req, numericId(req), session));
    await photos.remove(photo);
    res.status(204).end();
  }));

  // Photos arrive as a raw image, not a multi-part form, so there is no form parser to attack.
  // They are served from outside the web root and can never run as a page.
  router.put("/menu/:id/photo", ...allow("menu.write"), personalLimiter("upload", 30), params(schemas.params.numericId),
    express.raw({ type: () => true, limit: photoLimit }),
    wrap(async (req, res) => {
      await photos.save(req, numericId(req), String(req.get("content-type")).split(";")[0].trim().toLowerCase(), req.body);
      res.status(204).end();
    }));
  router.get("/menu/:id/photo", requireAuth, params(schemas.params.numericId), wrap(async (req, res) => {
    const photo = await photos.read(numericId(req));
    res.set({ "Content-Type": photo.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" });
    res.sendFile(path.resolve(photo.path), { dotfiles: "deny" });
  }));

  // ---------- Inventory ----------
  router.get("/inventory", ...allow("inventory.read"), wrap(async (_req, res) => res.json({ items: await catalog.listInventory() })));
  router.post("/inventory", ...allow("inventory.write"), validate(schemas.ingredient), wrap(async (req, res) => res.status(201).json(await purchasing.addIngredient(req, req.body))));
  router.put("/inventory/:id", ...allow("inventory.write"), params(schemas.params.numericId), validate(schemas.ingredientDetails), wrap(async (req, res) => res.json(await purchasing.updateIngredient(req, numericId(req), req.body))));

  // ---------- Suppliers, purchase orders, stocktakes and waste ----------
  router.get("/suppliers", ...allow("inventory.read"), wrap(async (_req, res) => res.json({ suppliers: await purchasing.listSuppliers() })));
  router.post("/suppliers", ...allow("inventory.write"), validate(schemas.supplier), wrap(async (req, res) => res.status(201).json(await purchasing.saveSupplier(req, null, req.body))));
  router.put("/suppliers/:id", ...allow("inventory.write"), params(schemas.params.supplierId), validate(schemas.supplier), wrap(async (req, res) => res.json(await purchasing.saveSupplier(req, req.validParams.id, req.body))));
  router.get("/purchase-orders", ...allow("inventory.read"), wrap(async (_req, res) => res.json({ orders: await purchasing.listOrders() })));
  router.post("/purchase-orders", ...allow("inventory.write"), validate(schemas.purchaseOrder), wrap(async (req, res) => res.status(201).json(await purchasing.createOrder(req, req.body))));
  router.post("/purchase-orders/:id/receive", ...allow("inventory.write"), params(schemas.params.purchaseId), validate(schemas.receiveOrder), wrap(async (req, res) => res.json(await purchasing.receiveOrder(req, req.validParams.id, req.body))));
  router.post("/purchase-orders/:id/cancel", ...allow("inventory.write"), params(schemas.params.purchaseId), wrap(async (req, res) => res.json(await purchasing.cancelOrder(req, req.validParams.id))));
  router.get("/stock-counts", ...allow("inventory.read"), wrap(async (_req, res) => res.json({ counts: await purchasing.listCounts() })));
  router.post("/stock-counts", ...allow("inventory.write"), validate(schemas.stocktake), wrap(async (req, res) => res.status(201).json(await purchasing.stocktake(req, req.body))));
  router.get("/waste", ...allow("inventory.read"), validate(schemas.salesQuery, "query"), wrap(async (req, res) => res.json({ waste: await purchasing.listWaste(req.validQuery.date) })));
  // The kitchen and bar see only names and units, never costs or suppliers
  router.get("/waste/choices", ...allow("waste.write"), wrap(async (_req, res) => res.json({ items: await purchasing.wasteChoices() })));
  router.post("/waste", ...allow("waste.write"), validate(schemas.waste), wrap(async (req, res) => res.status(201).json(await purchasing.logWaste(req, req.body))));
  router.post("/inventory/:id/adjust", ...allow("inventory.write"), params(schemas.params.numericId), validate(schemas.stockAdjustment),
    tx((req, session) => catalog.adjustStock(req, numericId(req), req.body.delta, req.body.reason, session)));

  // ---------- Orders and tables (waiter, own orders only) ----------
  router.get("/orders", ...allow("orders.write"), wrap(async (req, res) => res.json({ orders: await orderService.listOwn(req.auth.user.username) })));
  router.post("/orders", ...allow("orders.write"), validate(schemas.placeOrder), once((req, session) => orderService.place(req, req.body, session), 201));
  router.put("/orders/:id", ...allow("orders.write"), params(schemas.params.orderId), validate(schemas.updateOrder), tx((req, session) => orderService.update(req, req.validParams.id, req.body, session)));
  router.post("/orders/:id/serve", ...allow("orders.write"), params(schemas.params.orderId), tx((req, session) => orderService.serve(req, req.validParams.id, session)));
  router.post("/orders/:id/cancel", ...allow("orders.write"), params(schemas.params.orderId), tx((req, session) => orderService.cancel(req, req.validParams.id, session)));
  // Orders from the website and table QR codes, waiting for someone to accept them
  router.get("/orders/incoming", ...allow("orders.write"), wrap(async (_req, res) => res.json({ orders: await orderService.incoming() })));
  router.post("/orders/:id/accept", ...allow("orders.write"), params(schemas.params.orderId), tx((req, session) => orderService.accept(req, req.validParams.id, session)));
  router.post("/orders/:id/decline", ...allow("orders.write"), params(schemas.params.orderId), validate(schemas.declineOrder), tx((req, session) => orderService.decline(req, req.validParams.id, req.body.reason, session)));
  router.get("/tables/qr", ...allow("settings.write"), wrap(async (_req, res) => res.json({ tables: await orderService.tableCodes(appOrigin) })));
  router.post("/tables/:no/qr", ...allow("settings.write"), requireStepUp, params(schemas.params.tableNo), wrap(async (req, res) => {
    await orderService.resetTableCode(req, Number(req.validParams.no));
    res.status(204).end();
  }));
  router.post("/orders/:id/send", ...allow("orders.write"), params(schemas.params.orderId), tx((req, session) => orderService.send(req, req.validParams.id, session)));
  router.post("/orders/:id/transfer", ...allow("orders.write"), params(schemas.params.orderId), validate(schemas.transferOrder), tx((req, session) => orderService.transfer(req, req.validParams.id, req.body.table, session)));
  // Voiding an order a station has started on throws food away, so a manager confirms a fresh code
  router.post("/orders/:id/void", ...allow("orders.void"), requireStepUp, params(schemas.params.orderId), validate(schemas.voidOrder), tx((req, session) => orderService.voidOrder(req, req.validParams.id, req.body.reason, session)));
  router.get("/tables", ...allow("orders.write"), wrap(async (req, res) => res.json({ tables: await orderService.tableStates(req.auth.user.username) })));
  router.post("/tables/:no/request-bill", ...allow("orders.write"), params(schemas.params.tableNo), wrap(async (req, res) => {
    const no = tableNumber(req);
    await inTransaction(db, (session) => orderService.requestBill(req, no, session));
    res.status(204).end();
  }));

  // ---------- Kitchen ----------
  router.get("/kitchen/tickets", ...allow("kitchen.read"), wrap(async (req, res) => res.json({ tickets: await orderService.kitchenTickets(req.auth.user.role) })));
  router.post("/kitchen/tickets/:id/status", ...allow("kitchen.update"), params(schemas.params.orderId), validate(schemas.kitchenStatus),
    tx((req, session) => orderService.kitchenUpdate(req, req.validParams.id, req.body.status, session)));

  // ---------- Billing ----------
  router.get("/billing/open-tables", ...allow("billing.pay"), wrap(async (_req, res) => res.json({ tables: await billing.openTables() })));
  // The bill is saved first; the gateway is called only after it has committed, never inside a transaction
  router.post("/billing/tables/:no/pay", ...allow("billing.pay"), params(schemas.params.tableNo), validate(schemas.pay), wrap(async (req, res) => {
    const no = tableNumber(req);
    const outcome = await idempotentTransaction(db, req, async (session) => ({ status: 201, body: await billing.pay(req, no, req.body, session) }));
    const bill = await billing.settle(req, outcome.body.no);
    res.status(bill.status === "Paid" ? 201 : 202).json({ ...bill, check: outcome.body.check });
  }));
  router.post("/billing/orders/:id/pay", ...allow("billing.pay"), params(schemas.params.orderId), validate(schemas.pay), wrap(async (req, res) => {
    const outcome = await idempotentTransaction(db, req, async (session) => ({ status: 201, body: await billing.pay(req, req.validParams.id, req.body, session) }));
    const bill = await billing.settle(req, outcome.body.no);
    res.status(bill.status === "Paid" ? 201 : 202).json({ ...bill, check: outcome.body.check });
  }));
  // ---------- Guests: loyalty members, vouchers, waitlist and feedback ----------
  // The number is sent in the body, never in the address, so it does not end up in logs
  router.post("/customers/lookup", ...allow("customers.lookup"), personalLimiter("member-lookup", 120), validate(schemas.customerLookup), wrap(async (req, res) => res.json(await guests.lookup(req.body.phone))));
  router.post("/customers", ...allow("customers.enrol"), validate(schemas.customer), wrap(async (req, res) => res.status(201).json(await guests.enrol(req, req.body))));
  router.get("/customers", ...allow("customers.read"), wrap(async (req, res) => {
    const list = await guests.list();
    await recordView(req, "Customer records viewed", "members", `Loyalty members · ${list.length} records`);
    res.json({ customers: list });
  }));
  router.get("/customers/:id/history", ...allow("customers.read"), params(schemas.params.customerId), wrap(async (req, res) => res.json({ history: await guests.history(req.validParams.id) })));
  router.get("/vouchers", ...allow("vouchers.manage"), wrap(async (_req, res) => res.json({ vouchers: await guests.listVouchers() })));
  router.post("/vouchers", ...allow("vouchers.manage"), validate(schemas.voucher), wrap(async (req, res) => res.status(201).json(await guests.createVoucher(req, req.body))));
  router.post("/vouchers/:code/active", ...allow("vouchers.manage"), params(schemas.params.voucherCode), validate(schemas.voucherActive), wrap(async (req, res) => res.json(await guests.setVoucherActive(req, req.validParams.code, req.body.active))));
  router.get("/waitlist", ...allow("waitlist.write"), wrap(async (_req, res) => res.json({ waitlist: await guests.listWaitlist() })));
  router.post("/waitlist", ...allow("waitlist.write"), validate(schemas.waitlistEntry), wrap(async (req, res) => res.status(201).json(await guests.addWaiting(req, req.body))));
  router.post("/waitlist/:id/seat", ...allow("waitlist.write"), params(schemas.params.waitId), validate(schemas.waitlistSeat), wrap(async (req, res) => res.json(await guests.closeWaiting(req, req.validParams.id, "Seated", req.body.table))));
  router.post("/waitlist/:id/left", ...allow("waitlist.write"), params(schemas.params.waitId), wrap(async (req, res) => res.json(await guests.closeWaiting(req, req.validParams.id, "Left"))));
  router.get("/feedback", ...allow("feedback.read"), wrap(async (_req, res) => res.json(await guests.listFeedback())));

  // ---------- Insights: sales, product mix, profit, staff and the daily close ----------
  const q = (req) => [req.validQuery.from, req.validQuery.to];
  router.get("/insights/summary", ...allow("reports.read"), validate(schemas.rangeQuery, "query"), wrap(async (req, res) => res.json(await insights.summary(...q(req)))));
  router.get("/insights/mix", ...allow("reports.read"), validate(schemas.rangeQuery, "query"), wrap(async (req, res) => res.json(await insights.productMix(...q(req)))));
  router.get("/insights/profit", ...allow("reports.read"), validate(schemas.rangeQuery, "query"), wrap(async (req, res) => res.json(await insights.profit(...q(req)))));
  router.get("/insights/staff", ...allow("reports.read"), validate(schemas.rangeQuery, "query"), wrap(async (req, res) => res.json(await insights.staff(...q(req)))));
  router.get("/insights/close", ...allow("reports.read"), validate(schemas.salesQuery, "query"), wrap(async (req, res) => res.json(await insights.dailyClose(req.validQuery.date))));
  router.get("/insights/today", ...allow("reports.read"), wrap(async (_req, res) => res.json(await insights.today())));
  // CSV downloads are limited and recorded, like the other exports
  const csvRoute = (path, name, build) => router.get(path, ...allow("reports.read"), personalLimiter("export", 10), validate(schemas.rangeQuery, "query"), wrap(async (req, res) => {
    const { rows, from, to } = await build(req);
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Report exported", details: `${name} CSV · ${from} to ${to}`, severity: "warning" });
    res.attachment(`${name.toLowerCase().replace(/ /g, "-")}-${from}-to-${to}.csv`).type("text/csv").send(toCsv(rows));
  }));
  csvRoute("/insights/days.csv", "Daily sales", async (req) => {
    const s = await insights.summary(...q(req));
    return { from: s.from, to: s.to, rows: [["Date", "Bills", "Revenue", "Net (without tax)"]].concat(s.byDay.map((d) => [d.date, d.bills, d.revenue, d.net])) };
  });
  csvRoute("/insights/mix.csv", "Product mix", async (req) => {
    const m = await insights.productMix(...q(req));
    return { from: m.from, to: m.to, rows: [["Item", "Category", "Quantity", "Sales", "Ingredient cost", "Profit", "Margin %", "Share of sales %"]].concat(m.items.map((i) => [i.name, i.cat, i.qty, i.sales, i.cost, i.profit, i.margin, i.share])) };
  });
  csvRoute("/insights/staff.csv", "Staff sales", async (req) => {
    const s = await insights.staff(...q(req));
    return { from: s.from, to: s.to, rows: [["Name", "Role", "Orders", "Sold (without tax)", "Bills collected", "Collected", "Tips collected", "Hours", "Pay", "Sold per hour"]].concat(s.people.map((p) => [p.name, p.role, p.orders, p.sold, p.bills, p.collected, p.tips, (p.minutes / 60).toFixed(2), p.labour, p.salesPerHour === null ? "" : p.salesPerHour])) };
  });
  router.get("/pay-rates", ...allow("pay.manage"), wrap(async (_req, res) => res.json({ rates: await insights.listRates() })));
  router.put("/pay-rates/:username", ...allow("pay.manage"), params(schemas.params.username), validate(schemas.payRate), wrap(async (req, res) => res.json(await insights.setRate(req, req.validParams.username, req.body.rate))));

  // ---------- People: time clock, timesheets, rota, leave and tips ----------
  router.get("/timeclock/me", ...allow("time.self"), wrap(async (req, res) => res.json(await people.me(req.auth.user.username))));
  router.post("/timeclock", ...allow("time.self"), validate(schemas.clockAction), wrap(async (req, res) => res.json(await people.clockSelf(req, req.body.action))));
  // A shared tablet: the person taps their name and enters their PIN (paused after 5 wrong tries)
  router.post("/timeclock/pin", requireAuth, authLimiter, validate(schemas.clockPin), wrap(async (req, res) => res.json(await people.clockByPin(req, req.body.username, req.body.pin, req.body.action))));
  router.get("/timeclock/now", ...allow("people.read"), wrap(async (_req, res) => res.json({ people: await people.onShift() })));
  router.put("/timeclock/:id", ...allow("people.manage"), params(schemas.params.clockId), validate(schemas.timeFix), wrap(async (req, res) => res.json(await people.fixEntry(req, req.validParams.id, req.body))));
  router.get("/timesheets", ...allow("people.read"), validate(schemas.weekQuery, "query"), wrap(async (req, res) => res.json(await people.timesheet(req.validQuery.week))));
  router.get("/timesheets.csv", ...allow("people.read"), personalLimiter("export", 10), validate(schemas.weekQuery, "query"), wrap(async (req, res) => {
    const sheet = await people.timesheet(req.validQuery.week);
    const rows = [["Name", "Username", "Role"].concat(sheet.week, ["Total hours"])].concat(sheet.people.map((p) => [p.name, p.username, p.role].concat(sheet.week.map((d) => (p.days[d] / 60).toFixed(2)), [(p.minutes / 60).toFixed(2)])));
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Report exported", details: `Timesheet CSV · week of ${sheet.week[0]}`, severity: "warning" });
    res.attachment(`timesheet-${sheet.week[0]}.csv`).type("text/csv").send(toCsv(rows));
  }));
  router.get("/rota", ...allow("rota.read"), validate(schemas.weekQuery, "query"), wrap(async (req, res) => res.json(await people.rotaWeek(req.validQuery.week))));
  router.post("/rota", ...allow("people.manage"), validate(schemas.shift), wrap(async (req, res) => res.status(201).json(await people.addShift(req, req.body))));
  router.delete("/rota/:id", ...allow("people.manage"), params(schemas.params.shiftId2), wrap(async (req, res) => { await people.removeShift(req, req.validParams.id); res.status(204).end(); }));
  router.post("/leave", ...allow("time.self"), validate(schemas.leaveRequest), wrap(async (req, res) => res.status(201).json(await people.requestLeave(req, req.body))));
  router.get("/leave", ...allow("people.read"), wrap(async (_req, res) => res.json({ leave: await people.listLeave() })));
  router.post("/leave/:id/approve", ...allow("people.manage"), params(schemas.params.leaveId), wrap(async (req, res) => res.json(await people.decideLeave(req, req.validParams.id, true))));
  router.post("/leave/:id/reject", ...allow("people.manage"), params(schemas.params.leaveId), wrap(async (req, res) => res.json(await people.decideLeave(req, req.validParams.id, false))));
  router.get("/tips", ...allow("people.read"), validate(schemas.salesQuery, "query"), wrap(async (req, res) => res.json(await people.tipsShare(req.validQuery.date))));

  // ---------- Shifts and the cash drawer ----------
  router.get("/shifts/current", ...allow("shifts.own"), wrap(async (req, res) => res.json({ shift: await shiftService.mine(req) })));
  router.post("/shifts", ...allow("shifts.own"), validate(schemas.openShift), wrap(async (req, res) => res.status(201).json(await shiftService.open(req, req.body.float))));
  router.post("/shifts/current/cash", ...allow("shifts.own"), validate(schemas.cashMovement), wrap(async (req, res) => res.json(await shiftService.move(req, req.body))));
  router.post("/shifts/current/close", ...allow("shifts.own"), validate(schemas.closeShift), wrap(async (req, res) => res.json(await shiftService.close(req, req.body.counted, req.body.note))));
  router.get("/shifts", ...allow("shifts.all"), validate(schemas.shiftQuery, "query"), wrap(async (req, res) => res.json({ shifts: await shiftService.list(req.validQuery.date) })));
  router.get("/shifts/:id", ...allow("shifts.all"), params(schemas.params.shiftId), wrap(async (req, res) => res.json(await shiftService.get(req.validParams.id))));
  router.post("/bills/:no/retry-payment", ...allow("billing.pay"), params(schemas.params.billNo), validate(schemas.retryPayment), wrap(async (req, res) => {
    const bill = await billing.retryPayment(req, req.validParams.no, req.body);
    res.status(bill.status === "Paid" ? 200 : 202).json(bill);
  }));
  // Past days are for roles with report access; a cashier works with today's bills only
  router.get("/bills", ...allow("billing.read"), validate(schemas.salesQuery, "query"), wrap(async (req, res) => {
    const bills = await billing.list(can(req.auth.user.role, "reports.read") ? req.validQuery : {});
    await recordView(req, "Customer records viewed", `bills:${JSON.stringify(req.validQuery)}`, `Bills · ${bills.length} records`);
    res.json({ bills });
  }));
  router.get("/bills/:no", ...allow("billing.read"), params(schemas.params.billNo), wrap(async (req, res) => {
    const bill = await billing.get(req.validParams.no, { todayOnly: !can(req.auth.user.role, "reports.read") });
    await recordView(req, "Bill viewed", req.validParams.no, req.validParams.no);
    res.json(bill);
  }));
  router.get("/bills/:no/phone", ...allow("customer.phone"), personalLimiter("phone", 30), params(schemas.params.billNo), wrap(async (req, res) => res.json({ phone: await billing.revealPhone(req, req.validParams.no) })));
  // Money leaves the business, so the manager confirms an authenticator code first
  router.post("/bills/:no/refund", ...allow("billing.refund"), requireStepUp, params(schemas.params.billNo), validate(schemas.refund), wrap(async (req, res) => {
    const outcome = await idempotentTransaction(db, req, (session) => billing.refund(req, req.validParams.no, req.body.reason, session));
    if (outcome.status === 200) await billing.reversePayment(req, req.validParams.no);
    res.status(outcome.status).json(outcome.body);
  }));

  // ---------- Approvals: the deciding person confirms an authenticator code first ----------
  router.get("/approvals", ...allow("approvals.read"), wrap(async (req, res) => res.json({ approvals: await approvals.listFor(req.auth.user.role) })));
  router.post("/approvals/:id/approve", ...allow("approvals.read"), requireStepUp, params(schemas.params.approvalId), wrap(async (req, res) => {
    const result = await inTransaction(db, (session) => approvals.approve(req, req.validParams.id, session));
    if (result && result.refund) await billing.reversePayment(req, result.no);
    res.json(result);
  }));
  router.post("/approvals/:id/reject", ...allow("approvals.read"), requireStepUp, params(schemas.params.approvalId), wrap(async (req, res) => {
    await inTransaction(db, (session) => approvals.reject(req, req.validParams.id, session));
    res.status(204).end();
  }));

  // ---------- Reservations ----------
  router.get("/reservations", ...allow("reservations.write"), validate(schemas.reservationQuery, "query"), wrap(async (req, res) => {
    const found = await reservations.list(req.validQuery);
    await recordView(req, "Customer records viewed", `reservations:${JSON.stringify(req.validQuery)}`, `Reservations · ${found.length} records`);
    res.json({ reservations: found });
  }));
  // Only the ID is kept for repeat requests, so guest details are never stored unencrypted
  router.post("/reservations", ...allow("reservations.write"), validate(schemas.reservation), wrap(async (req, res) => {
    const outcome = await idempotentTransaction(db, req, async (session) => ({ status: 201, body: { id: (await reservations.create(req, req.body, session)).id } }));
    res.status(outcome.status).json(await reservations.get(outcome.body.id));
  }));
  // A POST, because a phone number in a URL would end up in access logs and browser history
  // Limited and recorded, so it cannot be used to work out a masked number by trying candidates
  router.post("/reservations/search", ...allow("reservations.write"), personalLimiter("phone-search", 30), validate(schemas.reservationSearch), wrap(async (req, res) => {
    const found = await reservations.list({ phone: req.body.phone });
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Customer number searched", details: `${found.length} found`, severity: "info" });
    res.json({ reservations: found });
  }));
  router.post("/reservations/:id/status", ...allow("reservations.write"), params(schemas.params.reservationId), validate(schemas.reservationStatus),
    tx((req, session) => reservations.setStatus(req, req.validParams.id, req.body.status, session, req.body.table)));
  router.get("/reservations/availability", ...allow("reservations.write"), validate(schemas.availabilityQuery, "query"), wrap(async (req, res) => res.json({ times: await reservations.availability(req.validQuery.date, req.validQuery.party) })));
  router.get("/reservations/:id/phone", ...allow("customer.phone"), personalLimiter("phone", 30), params(schemas.params.reservationId), wrap(async (req, res) => res.json({ phone: await reservations.revealPhone(req, req.validParams.id) })));

  // ---------- Reports and exports: limited and recorded, because bulk export is how insiders take data ----------
  router.get("/reports/sales", ...allow("reports.read"), validate(schemas.salesQuery, "query"), wrap(async (req, res) => res.json(await billing.salesReport(req.validQuery.date))));
  router.get("/reports/trend", ...allow("reports.read"), wrap(async (_req, res) => res.json({ days: await billing.trend(7) })));
  router.get("/reports/sales.csv", ...allow("reports.read"), personalLimiter("export", 10), validate(schemas.salesQuery, "query"), wrap(async (req, res) => {
    const bills = await billing.list(req.validQuery);
    const rows = [["Bill", "Time", "Order", "Method", "Subtotal", "Discount", "Tax", "Total", "Status"]]
      .concat(bills.map((b) => [b.no, b.createdAt.toISOString(), b.label, b.method, b.subtotal, b.discount, b.tax, b.total, b.status]));
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Report exported", details: `Sales CSV · ${bills.length} bills`, severity: "warning" });
    res.attachment("sales.csv").type("text/csv").send(toCsv(rows));
  }));

  // ---------- Audit log ----------
  const auditRows = (query) => {
    // Only entries in the signed chain are shown; anything else makes the integrity check fail
    const filter = { seq: { $exists: true } };
    if (query.severity) filter.severity = query.severity;
    if (query.before) filter.at = { $lt: new Date(query.before) };
    return db.collection("audit_events").find(filter, { projection: { _id: 0 } }).sort({ at: -1, _id: -1 }).limit(query.limit).toArray();
  };
  router.get("/audit", ...allow("audit.read"), validate(schemas.auditQuery, "query"), wrap(async (req, res) => res.json({ entries: await auditRows(req.validQuery) })));
  router.get("/audit/verify", ...allow("audit.read"), personalLimiter("audit-verify", 60), wrap(async (_req, res) => res.json(await verifyChain(db))));
  // Recording the review is what makes it a routine: an overdue one raises a reminder
  router.post("/audit/review", ...allow("audit.read"), validate(schemas.auditReview), wrap(async (req, res) => {
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Audit log reviewed", details: req.body.note, severity: "info" });
    res.status(204).end();
  }));
  router.get("/audit/public-keys", ...allow("audit.read"), wrap(async (_req, res) => res.json({ keys: publicKeys(db) })));

  // ---------- Security alerts and customer data rights ----------
  router.get("/alerts", ...allow("alerts.manage"), wrap(async (_req, res) => res.json({ alerts: await alerts.listOpen() })));
  router.post("/alerts/:id/acknowledge", ...allow("alerts.manage"), params(schemas.params.alertId), wrap(async (req, res) => {
    await alerts.acknowledge(req, req.validParams.id);
    res.status(204).end();
  }));
  router.post("/customers/erase", ...allow("customer.erase"), requireStepUp, validate(schemas.eraseCustomer), tx((req, session) => customers.erase(req, req.body.phone, session)));
  router.get("/audit.csv", ...allow("audit.read"), personalLimiter("export", 10), validate(schemas.auditQuery, "query"), wrap(async (req, res) => {
    const entries = await auditRows(req.validQuery);
    const rows = [["Time", "User", "Role", "Action", "Details", "Severity", "IP"]].concat(entries.map((e) => [e.at.toISOString(), e.actor, e.role, e.action, e.details, e.severity, e.ip]));
    await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Audit log exported", details: `${entries.length} entries`, severity: "warning" });
    res.attachment("audit.csv").type("text/csv").send(toCsv(rows));
  }));


  // ---------- Cafe details: an allow-list, so no other key can ever be written ----------
  router.put("/settings/cafe", ...allow("settings.write"), validate(schemas.cafeDetails), wrap(async (req, res) => res.json(await cafe.save(req, req.body))));

  // ---------- Operating settings: tables, tax, discount limits and receipt ----------
  router.get("/settings", ...allow("settings.write"), wrap(async (_req, res) => res.json(settings.get())));
  router.put("/settings", ...allow("settings.write"), requireStepUp, validate(schemas.operations), wrap(async (req, res) => res.json(await settings.save(req, req.body))));

  // ---------- Staff requests (quiz Q2/Q3). Identity and role come only from the session. ----------
  router.get("/requests", ...allow("requests.read"), validate(schemas.requestQuery, "query"), wrap(async (req, res) => {
    res.json(await staffRequests.list(req.auth.user, req.validQuery));
  }));
  router.post("/requests", ...allow("requests.submit"), validate(schemas.staffRequest), wrap(async (req, res) => {
    res.status(201).json(await staffRequests.create(req, req.body));
  }));
  router.get("/requests/:id", ...allow("requests.read"), params(schemas.params.requestId), wrap(async (req, res) => {
    res.json(await staffRequests.get(req.auth.user, req.validParams.id));
  }));
  router.get("/requests/:id/history", ...allow("requests.read"), params(schemas.params.requestId), wrap(async (req, res) => {
    res.json({ history: await staffRequests.history(req.auth.user, req.validParams.id) });
  }));
  for (const action of ["claim", "resolve", "reject"]) {
    router.post(`/requests/:id/${action}`, ...allow("requests.review"), params(schemas.params.requestId),
      validate(action === "reject" ? schemas.requestReject : schemas.requestTransition),
      wrap(async (req, res) => res.json(await staffRequests.transition(req, req.validParams.id, action, req.body))));
  }

  // ---------- Live updates: names of changed areas only; the stream ends with the session ----------
  router.get("/events", requireAuth, (req, res) => {
    const { jti } = req.auth.session;
    const { role } = req.auth.user;
    events.stream(req, res, async () => {
      const now = await sessions.load(req);
      return Boolean(now) && now.session.jti === jti && now.user.role === role;
    });
  });

  // ---------- Snapshot: one role-filtered read for the screens. Each role gets only its own data. ----------
  router.get("/snapshot", requireAuth, wrap(async (req, res) => {
    const { username, role } = req.auth.user;
    const allowed = (permission) => can(role, permission);
    const snapshot = {
      // The receipt text is only for those who print bills
      constants: { tables: settings.get().tables, activeStatuses: ACTIVE_ORDER_STATUSES, taxRate: settings.taxRate(), discountLimit: settings.discountLimit(role), serviceRate: settings.serviceRate(), requireShift: settings.get().requireShift, categories: settings.get().categories, orderTypes: settings.get().orderTypes, ...(allowed("billing.read") ? { receipt: settings.get().receipt } : {}) }
    };
    const parts = [];
    // Results are added in this fixed order, not as each query finishes, so identical data gives
    // identical text and the screens redraw only when something really changed
    const add = (key, load) => parts.push(load().then((value) => [key, value]));
    if (allowed("menu.read")) add("menu", () => (allowed("menu.write") ? catalog.listForAdmin() : catalog.listForSale()));
    if (allowed("orders.write")) {
      add("orders", () => orderService.listOwn(username));
      add("tables", () => orderService.tableStates(username));
    }
    if (allowed("kitchen.read")) add("tickets", () => orderService.kitchenTickets(role));
    if (allowed("billing.pay") || allowed("reports.read")) add("openTables", () => billing.openTables());
    if (allowed("billing.read")) add("bills", () => viewedList(req, "bills", "Bills", () => billing.list()));
    if (allowed("inventory.read")) add("inventory", () => catalog.listInventory());
    if (allowed("reservations.write")) add("reservations", () => viewedList(req, "reservations", "Reservations", () => reservations.list()));
    if (allowed("reports.read")) add("sales", () => billing.salesReport());
    if (allowed("approvals.read")) add("approvals", () => approvals.listFor(role));
    if (allowed("users.manage")) add("users", () => userService.list());
    if (allowed("billing.read")) add("staffNames", async () => Object.fromEntries((await db.collection("users").find({}, { projection: { username: 1, name: 1 } }).toArray()).map((u) => [u.username, u.name])));
    if (allowed("audit.read")) add("recentAudit", () => auditRows({ limit: 20 }));
    if (allowed("alerts.manage")) add("alerts", () => alerts.listOpen());
    // The kitchen needs only the cafe's name on its screen (least privilege)
    add("cafe", async () => {
      const details = await cafe.get();
      return role === "Kitchen" || role === "Barista" ? { name: details.name } : details;
    });
    res.json({ ...snapshot, ...Object.fromEntries(await Promise.all(parts)) });
  }));

  return router;
}

module.exports = { createBusinessRouter };
