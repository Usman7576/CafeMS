// Insights for managers: sales over a date range, busiest hours, product mix with cost and margin,
// profit after ingredients, waste and staff pay, sales by staff, and the daily close.
//
// Sales are counted from paid bills. A bill that is one part of a split check counts its share of the
// items. Net sales are what was paid without tax (service charge included); tips are kept apart.
const { AppError } = require("../lib/errors");
const { localDate, dayRange, localHour, isRealDate } = require("../lib/domain");
const { inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 92;
const round2 = (n) => Math.round(n * 100) / 100;

function createInsightService({ db }) {
  const bills = db.collection("bills");
  const orders = db.collection("orders");
  const menu = db.collection("menu");
  const inventory = db.collection("inventory");
  const waste = db.collection("waste_log");
  const clock = db.collection("timeclock");
  const rates = db.collection("pay_rates");
  const users = db.collection("users");
  const shifts = db.collection("shifts");

  function range(from, to) {
    const end = to || localDate();
    const start = from || end;
    if (!isRealDate(start) || !isRealDate(end) || start > end) throw new AppError(400, "invalid_input", "Choose a start date on or before the end date.");
    const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
    if (days > MAX_DAYS) throw new AppError(400, "invalid_input", `Choose a range of up to ${MAX_DAYS} days.`);
    return { from: start, to: end, days, start: dayRange(start).start, end: dayRange(end).end };
  }
  const dates = (r) => Array.from({ length: r.days }, (_, i) => localDate(r.start.getTime() + i * DAY + 12 * 60 * 60 * 1000));
  const billsIn = (r) => bills.find({ createdAt: { $gte: r.start, $lt: r.end } }, { projection: { phoneEnc: 0, phoneIndex: 0, phoneMask: 0 } }).limit(50000).toArray();
  const net = (b) => b.total - b.tax;

  // What one portion of each menu item costs, from today's average ingredient costs
  async function portionCosts() {
    const [items, stock] = await Promise.all([menu.find({}, { projection: { recipe: 1 } }).toArray(), inventory.find({}, { projection: { costPaisa: 1 } }).toArray()]);
    const cost = new Map(stock.map((s) => [s._id, s.costPaisa || 0]));
    return new Map(items.map((m) => [m._id, (m.recipe || []).reduce((s, r) => s + (r.qtyMilli * (cost.get(r.ing) || 0)) / 1000, 0) / 100]));
  }

  // Labour: hours worked inside the range, at each person's hourly rate
  async function labour(r) {
    const [entries, payRates, who] = await Promise.all([
      clock.find({ in: { $lt: r.end }, $or: [{ out: null }, { out: { $gt: r.start } }] }).toArray(),
      rates.find().toArray(),
      users.find({}, { projection: { username: 1, name: 1, role: 1 } }).toArray()
    ]);
    const rate = new Map(payRates.map((p) => [p._id, p.rate]));
    const names = new Map(who.map((u) => [u.username, u]));
    const people = new Map();
    for (const e of entries) {
      const from = e.in < r.start ? r.start : e.in;
      const until = e.out || new Date(Math.min(Date.now(), r.end.getTime()));
      const to = until > r.end ? r.end : until;
      const minutes = Math.max(0, (to - from) / 60000);
      const row = people.get(e.username) || { username: e.username, name: (names.get(e.username) || {}).name || e.username, role: e.role, minutes: 0, rate: rate.get(e.username) || 0 };
      row.minutes += minutes;
      people.set(e.username, row);
    }
    const list = [...people.values()].map((p) => ({ ...p, minutes: Math.round(p.minutes), cost: Math.round((p.minutes / 60) * p.rate) })).sort((a, b) => b.cost - a.cost || b.minutes - a.minutes);
    return { people: list, minutes: list.reduce((s, p) => s + p.minutes, 0), cost: list.reduce((s, p) => s + p.cost, 0), missingRates: list.filter((p) => !p.rate).map((p) => p.name) };
  }

  async function summary(from, to) {
    const r = range(from, to);
    const rows = await billsIn(r);
    const paid = rows.filter((b) => b.status === "Paid");
    const refunded = rows.filter((b) => b.status === "Refunded");
    const sum = (list, f) => list.reduce((s, b) => s + f(b), 0);
    const byDay = new Map(dates(r).map((d) => [d, { date: d, revenue: 0, net: 0, bills: 0 }]));
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const byMethod = { Cash: 0, Card: 0, Wallet: 0, Points: 0 };
    const byType = { "dine-in": 0, takeaway: 0, delivery: 0 };
    const byCat = new Map();
    for (const b of paid) {
      const day = byDay.get(localDate(b.createdAt.getTime()));
      if (day) { day.revenue += b.total; day.net += net(b); day.bills += 1; }
      const weekday = (new Date(b.createdAt.getTime() + 5 * 60 * 60 * 1000).getUTCDay() + 6) % 7;
      heat[weekday][localHour(b.createdAt)] += b.total;
      byMethod[b.method] = (byMethod[b.method] || 0) + b.total;
      byType[b.type || "dine-in"] = (byType[b.type || "dine-in"] || 0) + b.total;
      const share = b.share === undefined ? 1 : b.share;
      for (const l of b.lines) byCat.set(l.cat || "Other", (byCat.get(l.cat || "Other") || 0) + l.price * l.qty * share);
    }
    // A split check counts as one visit, so the average ticket is per check, not per part
    const checks = new Set(paid.map((b) => b.checkId || b._id)).size;
    const revenue = sum(paid, (b) => b.total);
    return {
      from: r.from, to: r.to, days: r.days,
      revenue, net: sum(paid, net), tax: sum(paid, (b) => b.tax), discounts: sum(paid, (b) => b.discount), service: sum(paid, (b) => b.service || 0),
      tips: sum(paid, (b) => b.tip || 0), bills: paid.length, checks, avgTicket: checks ? Math.round(revenue / checks) : 0,
      refunds: refunded.length, refundAmount: sum(refunded, (b) => b.total),
      byDay: [...byDay.values()], heat, byMethod, byType,
      byCat: [...byCat.entries()].map(([cat, value]) => ({ cat, value: Math.round(value) })).sort((a, b) => b.value - a.value)
    };
  }

  // Each item's quantity, sales, ingredient cost and margin
  async function productMix(from, to) {
    const r = range(from, to);
    const [rows, costs] = await Promise.all([billsIn(r), portionCosts()]);
    const items = new Map();
    for (const b of rows.filter((x) => x.status === "Paid")) {
      const share = b.share === undefined ? 1 : b.share;
      for (const l of b.lines) {
        const key = l.id;
        const row = items.get(key) || { id: l.id, name: l.name, cat: l.cat || "Other", qty: 0, sales: 0, cost: 0 };
        row.qty += l.qty * share;
        row.sales += l.price * l.qty * share;
        row.cost += (costs.get(l.id) || 0) * l.qty * share;
        items.set(key, row);
      }
    }
    const list = [...items.values()];
    const total = list.reduce((s, i) => s + i.sales, 0);
    return {
      from: r.from, to: r.to, total: Math.round(total),
      items: list.map((i) => ({ ...i, qty: round2(i.qty), sales: Math.round(i.sales), cost: Math.round(i.cost), profit: Math.round(i.sales - i.cost), margin: i.sales ? Math.round(((i.sales - i.cost) / i.sales) * 1000) / 10 : 0, share: total ? Math.round((i.sales / total) * 1000) / 10 : 0 }))
        .sort((a, b) => b.sales - a.sales)
    };
  }

  // Profit = net sales − ingredient cost of what was sold − waste − staff pay
  async function profit(from, to) {
    const r = range(from, to);
    const [s, mix, wasted, pay] = await Promise.all([summary(from, to), productMix(from, to), waste.find({ at: { $gte: r.start, $lt: r.end } }, { projection: { value: 1 } }).toArray(), labour(r)]);
    const ingredients = mix.items.reduce((sum, i) => sum + i.cost, 0);
    const wasteValue = Math.round(wasted.reduce((sum, w) => sum + (w.value || 0), 0));
    const gross = s.net - ingredients - wasteValue;
    const after = gross - pay.cost;
    const pct = (n) => (s.net ? Math.round((n / s.net) * 1000) / 10 : 0);
    return {
      from: r.from, to: r.to, net: s.net, ingredients, waste: wasteValue, grossProfit: gross, labour: pay.cost, profit: after,
      foodCostPct: pct(ingredients + wasteValue), labourPct: pct(pay.cost), profitPct: pct(after), missingRates: pay.missingRates
    };
  }

  // Sales taken by each waiter (from the orders on each bill) and collected by each cashier, and hours
  async function staff(from, to) {
    const r = range(from, to);
    const [rows, pay, who] = await Promise.all([billsIn(r), labour(r), users.find({}, { projection: { username: 1, name: 1, role: 1 } }).toArray()]);
    const paid = rows.filter((b) => b.status === "Paid");
    const owners = new Map((await orders.find({ _id: { $in: [...new Set(paid.flatMap((b) => b.orderIds || []))] } }, { projection: { waiter: 1 } }).toArray()).map((o) => [o._id, o.waiter]));
    const names = new Map(who.map((u) => [u.username, u]));
    const people = new Map();
    const row = (username) => {
      if (!people.has(username)) people.set(username, { username, name: (names.get(username) || {}).name || username, role: (names.get(username) || {}).role || "", sold: 0, orders: 0, collected: 0, bills: 0, tips: 0, minutes: 0, labour: 0 });
      return people.get(username);
    };
    for (const b of paid) {
      const waiter = owners.get((b.orderIds || [])[0]);
      if (waiter) { row(waiter).sold += net(b); row(waiter).orders += 1; }
      if (b.cashier) { const c = row(b.cashier); c.collected += b.total; c.bills += 1; c.tips += b.tip || 0; }
    }
    for (const p of pay.people) { const x = row(p.username); x.minutes = p.minutes; x.labour = p.cost; }
    const list = [...people.values()].map((p) => ({ ...p, salesPerHour: p.minutes ? Math.round(p.sold / (p.minutes / 60)) : null })).sort((a, b) => b.sold - a.sold || b.collected - a.collected);
    return { from: r.from, to: r.to, people: list, labour: pay.cost, minutes: pay.minutes, missingRates: pay.missingRates };
  }

  // The day's close: what was taken and how, what was given away or lost, and how the drawers balanced
  async function dailyClose(date) {
    const r = range(date, date);
    const [s, dayShifts, voided, wasted, mix] = await Promise.all([
      summary(r.from, r.to),
      shifts.find({ openedAt: { $gte: r.start, $lt: r.end } }).toArray(),
      orders.find({ "voided.at": { $gte: r.start, $lt: r.end } }, { projection: { items: 1, voided: 1 } }).toArray(),
      waste.find({ at: { $gte: r.start, $lt: r.end } }, { projection: { value: 1 } }).toArray(),
      productMix(r.from, r.to)
    ]);
    const unpaid = await bills.countDocuments({ createdAt: { $gte: r.start, $lt: r.end }, status: { $in: ["Pending Payment", "Payment Failed"] } });
    return {
      date: r.from, revenue: s.revenue, net: s.net, tax: s.tax, service: s.service, discounts: s.discounts, tips: s.tips,
      bills: s.bills, checks: s.checks, avgTicket: s.avgTicket, refunds: s.refunds, refundAmount: s.refundAmount, byMethod: s.byMethod, byType: s.byType,
      unpaid, voids: voided.length, voidValue: voided.reduce((sum, o) => sum + o.items.reduce((t, i) => t + i.price * i.qty, 0), 0),
      waste: Math.round(wasted.reduce((sum, w) => sum + (w.value || 0), 0)),
      shifts: { count: dayShifts.length, open: dayShifts.filter((x) => x.status === "Open").length, overShort: dayShifts.filter((x) => x.status === "Closed").reduce((sum, x) => sum + (x.overShort || 0), 0) },
      top: mix.items.slice(0, 5).map((i) => ({ name: i.name, qty: i.qty, sales: i.sales }))
    };
  }

  // Today against the same weekday last week, for the overview
  async function today() {
    const day = localDate();
    const lastWeek = localDate(Date.now() - 7 * DAY);
    const [now, before, mix] = await Promise.all([summary(day, day), summary(lastWeek, lastWeek), productMix(day, day)]);
    const change = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);
    return {
      revenue: now.revenue, lastWeek: before.revenue, change: change(now.revenue, before.revenue),
      checks: now.checks, checksChange: change(now.checks, before.checks), avgTicket: now.avgTicket, tips: now.tips,
      top: mix.items.slice(0, 5).map((i) => ({ name: i.name, qty: i.qty, sales: i.sales }))
    };
  }

  // ---------- Hourly pay rates (for labour cost) ----------
  async function listRates() {
    const [who, payRates] = await Promise.all([users.find({ role: { $in: ["Waiter", "Barista", "Kitchen", "Cashier", "Manager"] }, status: "Active" }, { projection: { username: 1, name: 1, role: 1 } }).sort({ name: 1 }).toArray(), rates.find().toArray()]);
    const rate = new Map(payRates.map((p) => [p._id, p.rate]));
    return who.map((u) => ({ username: u.username, name: u.name, role: u.role, rate: rate.get(u.username) || 0 }));
  }
  async function setRate(req, username, rate) {
    return inTransaction(db, async (session) => {
      const person = await users.findOne({ username, status: "Active" }, { session });
      if (!person) throw new AppError(404, "not_found", "Staff member not found.");
      const old = await rates.findOne({ _id: username }, { session });
      await rates.updateOne({ _id: username }, { $set: { rate, setBy: req.auth.user.username, setAt: new Date() } }, { upsert: true, session });
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Pay rate changed", details: `${username}: Rs ${old ? old.rate : 0} to Rs ${rate} an hour`, severity: "warning" }, { session });
      return { username, rate };
    });
  }

  return { summary, productMix, profit, staff, dailyClose, today, listRates, setRate };
}

module.exports = { createInsightService };
