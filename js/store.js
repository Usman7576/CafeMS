// Prototype data layer ("fake backend").
// In the final system every function here becomes a call to the Node.js/Express
// REST API, which authenticates the user and enforces RBAC on every request.
// Demo data lives in localStorage so all roles on this device share it.
(function () {
  const DB_KEY = "cms_db_v3";
  const TAX_RATE = 0.16;
  const ACTIVE = ["Placed", "Preparing", "Ready"];
  const ROLES = ["Waiter", "Kitchen", "Cashier", "Manager", "Admin"];
  const DISCOUNT_LIMIT = { Cashier: 10, Manager: 25, Admin: 25 };
  const SIM = { toPreparing: 10000, toReady: 20000 };
  const TABLES = [
    { no: 1, seats: 2 }, { no: 2, seats: 2 }, { no: 3, seats: 4 }, { no: 4, seats: 4 }, { no: 5, seats: 4 },
    { no: 6, seats: 4 }, { no: 7, seats: 6 }, { no: 8, seats: 2 }, { no: 9, seats: 4 }, { no: 10, seats: 8 }
  ];

  let db = null;
  const listeners = [];
  const now = function () { return Date.now(); };

  function load() { try { return JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { return null; } }
  function persist() { try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) {} }
  function emit(changed) { listeners.forEach(function (fn) { try { fn(changed || []); } catch (e) { console.error(e); } }); }
  function commit(changed) { persist(); emit(changed); }
  function fail(msg) { const e = new Error(msg); e.userMessage = msg; throw e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ------------------------------------------------------------------ audit (hash-chained)
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  function entryHash(e) { return fnv([e.id, e.at, e.user, e.role, e.action, e.details, e.severity, e.prev].join("|")); }
  function log(username, action, details, severity, at) {
    const prev = db.audit.length ? db.audit[db.audit.length - 1].hash : "00000000";
    const u = username ? findUser(username) : null;
    const e = { id: ++db.seq.audit, at: at || now(), user: username || "system", name: u ? u.name : (username || "System"),
      role: u ? u.role : (username ? "Unknown" : "System"), action: action, details: details || "", severity: severity || "info", prev: prev };
    e.hash = entryHash(e);
    db.audit.push(e);
    return e;
  }

  // ------------------------------------------------------------------ helpers
  function findUser(username) {
    const u = String(username || "").toLowerCase();
    return db.users.find(function (x) { return x.username === u; }) || null;
  }
  function menuItem(id) { return db.menu.find(function (m) { return m.id === id; }) || null; }
  function ingredient(id) { return db.inventory.find(function (i) { return i.id === id; }) || null; }
  function round2(n) { return Math.round(n * 1000) / 1000; }

  function totals(lines, discountPct) {
    const sub = lines.reduce(function (s, l) { return s + l.price * l.qty; }, 0);
    const discount = Math.round(sub * (discountPct || 0) / 100);
    const tax = Math.round((sub - discount) * TAX_RATE);
    return { sub: sub, discount: discount, tax: tax, total: sub - discount + tax, count: lines.reduce(function (s, l) { return s + l.qty; }, 0) };
  }
  function snapshot(lines) {
    return lines.map(function (l) { const m = menuItem(l.id); return { id: m.id, name: m.name, price: m.price, qty: l.qty, cat: m.cat }; });
  }
  function stockDelta(lines, sign) {
    lines.forEach(function (l) {
      const m = menuItem(l.id);
      if (!m) return;
      (m.recipe || []).forEach(function (r) {
        const ing = ingredient(r.ing);
        if (ing) ing.qty = Math.max(0, round2(ing.qty + sign * r.qty * l.qty));
      });
    });
  }
  function stockStatus(ing) { return ing.qty <= 0 ? "out" : ing.qty <= ing.reorder ? "low" : "ok"; }
  function unavailableReason(m) {
    if (!m.available) return "Switched off";
    const short = (m.recipe || []).find(function (r) { const i = ingredient(r.ing); return !i || i.qty < r.qty; });
    return short ? "Out of " + ingredient(short.ing).name.toLowerCase() : null;
  }
  function openOrdersOn(no) {
    return db.orders.filter(function (o) { return o.table === no && !o.billed && o.status !== "Cancelled"; });
  }
  function isToday(ts) { const d = new Date(ts), n = new Date(); return d.toDateString() === n.toDateString(); }

  // ------------------------------------------------------------------ seed
  function seed() {
    const t = now();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const span = Math.max(t - start.getTime() - 20 * 60000, 60 * 60000);
    const early = function (frac) { return Math.min(t - 25 * 60000, start.getTime() + span * frac); };

    db = {
      v: 3,
      seq: { order: 1040, bill: 5000, audit: 0, menu: 15, ing: 16 },
      settings: { kitchenSim: true },
      billRequested: {},
      users: [
        { username: "m.usman",     name: "M. Usman",       role: "Waiter",  status: "Active",   lastLogin: null },
        { username: "hina.malik",  name: "Hina Malik",     role: "Waiter",  status: "Active",   lastLogin: t - 3 * 3600000 },
        { username: "chef.imran",  name: "Imran Qureshi",  role: "Kitchen", status: "Active",   lastLogin: t - 4 * 3600000 },
        { username: "bilal.ahmed", name: "Bilal Ahmed",    role: "Cashier", status: "Active",   lastLogin: t - 4 * 3600000 },
        { username: "sara.khan",   name: "Sara Khan",      role: "Manager", status: "Active",   lastLogin: t - 5 * 3600000 },
        { username: "farah.admin", name: "Farah Siddiqui", role: "Admin",   status: "Active",   lastLogin: t - 26 * 3600000 },
        { username: "old.staff",   name: "Former Staff",   role: "Waiter",  status: "Disabled", lastLogin: t - 40 * 86400000 }
      ],
      inventory: [
        { id: 1,  name: "Coffee beans",    unit: "kg",  qty: 4.2, reorder: 2,   supplier: "Bean Roasters Co." },
        { id: 2,  name: "Milk",            unit: "L",   qty: 18,  reorder: 8,   supplier: "Premier Dairy" },
        { id: 3,  name: "Sugar",           unit: "kg",  qty: 6,   reorder: 2,   supplier: "Metro Wholesale" },
        { id: 4,  name: "Caramel syrup",   unit: "L",   qty: 0.4, reorder: 0.5, supplier: "Sweet Supplies" },
        { id: 5,  name: "Mango pulp",      unit: "kg",  qty: 0,   reorder: 2,   supplier: "FreshFarm Produce" },
        { id: 6,  name: "Tea leaves",      unit: "kg",  qty: 1.5, reorder: 0.5, supplier: "Metro Wholesale" },
        { id: 7,  name: "Limes",           unit: "pcs", qty: 40,  reorder: 20,  supplier: "FreshFarm Produce" },
        { id: 8,  name: "Chicken breast",  unit: "kg",  qty: 3.5, reorder: 2,   supplier: "Metro Wholesale" },
        { id: 9,  name: "Bread slices",    unit: "pcs", qty: 64,  reorder: 30,  supplier: "Metro Wholesale" },
        { id: 10, name: "Potatoes",        unit: "kg",  qty: 9,   reorder: 5,   supplier: "FreshFarm Produce" },
        { id: 11, name: "Cheese",          unit: "kg",  qty: 1.2, reorder: 1.5, supplier: "Premier Dairy" },
        { id: 12, name: "Chocolate",       unit: "kg",  qty: 2,   reorder: 1,   supplier: "Sweet Supplies" },
        { id: 13, name: "Cream cheese",    unit: "kg",  qty: 0,   reorder: 1,   supplier: "Premier Dairy" },
        { id: 14, name: "Croissant dough", unit: "pcs", qty: 18,  reorder: 10,  supplier: "Sweet Supplies" },
        { id: 15, name: "Green tea",       unit: "kg",  qty: 0.6, reorder: 0.3, supplier: "Metro Wholesale" },
        { id: 16, name: "Vanilla syrup",   unit: "L",   qty: 1.1, reorder: 0.5, supplier: "Sweet Supplies" }
      ],
      menu: [
        { id: 1,  name: "Espresso",              cat: "Coffee",      price: 350, desc: "Double shot, rich crema.", available: true, recipe: [{ ing: 1, qty: 0.018 }] },
        { id: 2,  name: "Cappuccino",            cat: "Coffee",      price: 520, desc: "Espresso, steamed milk, thick foam.", available: true, recipe: [{ ing: 1, qty: 0.018 }, { ing: 2, qty: 0.15 }] },
        { id: 3,  name: "Caffè Latte",           cat: "Coffee",      price: 550, desc: "Smooth espresso with silky milk.", available: true, recipe: [{ ing: 1, qty: 0.018 }, { ing: 2, qty: 0.25 }] },
        { id: 4,  name: "Caramel Macchiato",     cat: "Coffee",      price: 650, desc: "Vanilla, milk, espresso, caramel drizzle.", available: true, recipe: [{ ing: 1, qty: 0.018 }, { ing: 2, qty: 0.2 }, { ing: 4, qty: 0.03 }, { ing: 16, qty: 0.02 }] },
        { id: 5,  name: "Iced Americano",        cat: "Cold Drinks", price: 480, desc: "Espresso over ice and cold water.", available: true, recipe: [{ ing: 1, qty: 0.018 }] },
        { id: 6,  name: "Mango Smoothie",        cat: "Cold Drinks", price: 590, desc: "Fresh mango, yoghurt, honey.", available: true, recipe: [{ ing: 5, qty: 0.25 }, { ing: 2, qty: 0.15 }] },
        { id: 7,  name: "Fresh Lime Soda",       cat: "Cold Drinks", price: 300, desc: "Sweet or salted.", available: true, recipe: [{ ing: 7, qty: 2 }, { ing: 3, qty: 0.02 }] },
        { id: 8,  name: "Green Tea",             cat: "Tea",         price: 250, desc: "Jasmine green tea, pot for one.", available: true, recipe: [{ ing: 15, qty: 0.005 }] },
        { id: 9,  name: "Karak Chai",            cat: "Tea",         price: 220, desc: "Strong spiced milk tea.", available: true, recipe: [{ ing: 6, qty: 0.01 }, { ing: 2, qty: 0.15 }, { ing: 3, qty: 0.02 }] },
        { id: 10, name: "Chicken Club Sandwich", cat: "Food",        price: 890, desc: "Grilled chicken, egg, served with fries.", available: true, recipe: [{ ing: 8, qty: 0.15 }, { ing: 9, qty: 3 }, { ing: 10, qty: 0.15 }] },
        { id: 11, name: "Grilled Panini",        cat: "Food",        price: 820, desc: "Mozzarella, pesto, sun-dried tomato.", available: true, recipe: [{ ing: 9, qty: 2 }, { ing: 11, qty: 0.08 }] },
        { id: 12, name: "Loaded Fries",          cat: "Food",        price: 560, desc: "Cheese sauce, jalapeños, spring onion.", available: true, recipe: [{ ing: 10, qty: 0.3 }, { ing: 11, qty: 0.06 }] },
        { id: 13, name: "Chocolate Brownie",     cat: "Desserts",    price: 420, desc: "Warm, with chocolate sauce.", available: true, recipe: [{ ing: 12, qty: 0.06 }] },
        { id: 14, name: "Blueberry Cheesecake",  cat: "Desserts",    price: 690, desc: "Baked New York style.", available: true, recipe: [{ ing: 13, qty: 0.12 }] },
        { id: 15, name: "Butter Croissant",      cat: "Desserts",    price: 380, desc: "Freshly baked every morning.", available: true, recipe: [{ ing: 14, qty: 1 }] }
      ],
      orders: [], bills: [], audit: []
    };

    // Earlier today: paid bills (drives reports)
    const combos = [
      [[2, 2], [13, 1]], [[9, 3], [15, 2]], [[10, 1], [5, 1]], [[3, 2], [11, 1]], [[1, 2], [4, 1], [13, 2]],
      [[12, 2], [7, 2]], [[8, 2], [15, 1]], [[2, 1], [3, 1], [10, 2]], [[9, 4], [15, 1]], [[4, 2], [13, 1]], [[11, 2], [5, 2]]
    ];
    const methods = ["Cash", "Card", "Cash", "Wallet", "Card", "Cash", "Card", "Card", "Cash", "Wallet", "Card"];
    const auditQ = [];
    auditQ.push([early(0.0), "sara.khan", "Signed in", "Manager session started", "info"]);
    auditQ.push([early(0.01), "chef.imran", "Signed in", "Kitchen session started", "info"]);
    auditQ.push([early(0.02), "bilal.ahmed", "Signed in", "Cashier session started", "info"]);
    auditQ.push([early(0.05), "sara.khan", "Stock restocked", "Milk +10 L (Premier Dairy)", "info"]);
    combos.forEach(function (c, i) {
      const at = early(0.08 + i * 0.075);
      const lines = snapshot(c.map(function (x) { return { id: x[0], qty: x[1] }; }));
      const pct = i === 4 ? 10 : 0;
      const tt = totals(lines, pct);
      const no = "B-" + (++db.seq.bill);
      const oid = "ORD-" + (1000 + i + 1);
      db.orders.push({ id: oid, table: TABLES[i % 10].no, items: lines, notes: "", status: "Served", waiter: i % 2 ? "hina.malik" : "m.usman",
        createdAt: at - 35 * 60000, updatedAt: at - 10 * 60000, billed: true, billNo: no });
      db.bills.push({ no: no, table: TABLES[i % 10].no, orderIds: [oid], lines: lines, discountPct: pct, subtotal: tt.sub, discount: tt.discount, tax: tt.tax,
        total: tt.total, method: methods[i], tendered: methods[i] === "Cash" ? Math.ceil(tt.total / 500) * 500 : tt.total,
        cashier: "bilal.ahmed", createdAt: at, status: "Paid" });
      auditQ.push([at, "bilal.ahmed", "Payment recorded", no + " · Table " + TABLES[i % 10].no + " · Rs " + tt.total.toLocaleString() + " · " + methods[i], "info"]);
      if (pct) auditQ.push([at + 1000, "bilal.ahmed", "Discount applied", no + " · " + pct + "% (Rs " + tt.discount + ")", "warning"]);
    });
    const refunded = db.bills[6];
    refunded.status = "Refunded";
    refunded.refund = { by: "sara.khan", at: refunded.createdAt + 20 * 60000, reason: "Wrong item served" };
    auditQ.push([refunded.refund.at, "sara.khan", "Refund issued", refunded.no + " · Rs " + refunded.total.toLocaleString() + " · Wrong item served", "high"]);
    auditQ.push([early(0.5), "farah.admin", "Price changed", "Caffè Latte: Rs 520 → Rs 550", "warning"]);
    auditQ.push([early(0.55), "unknown.user", "Sign-in failed", "Unknown username", "warning"]);
    auditQ.push([early(0.6), "farah.admin", "Account disabled", "old.staff (Waiter)", "high"]);
    auditQ.sort(function (a, b) { return a[0] - b[0]; }).forEach(function (a) { log(a[1], a[2], a[3], a[4], a[0]); });
    db.seq.order = 1000 + combos.length;

    // Open tables right now
    const mk = function (table, lines, notes, status, waiter, minsAgo, updAgo) {
      const items = snapshot(lines);
      db.orders.push({ id: "ORD-" + (++db.seq.order), table: table, items: items, notes: notes, status: status, waiter: waiter,
        createdAt: t - minsAgo * 60000, updatedAt: t - updAgo * 60000, billed: false });
    };
    mk(6, [{ id: 2, qty: 2 }, { id: 13, qty: 2 }], "", "Served", "m.usman", 38, 24);
    mk(9, [{ id: 3, qty: 1 }, { id: 11, qty: 1 }], "", "Served", "hina.malik", 30, 15);
    mk(7, [{ id: 12, qty: 2 }, { id: 7, qty: 3 }, { id: 11, qty: 1 }], "", "Ready", "m.usman", 16, 1);
    mk(4, [{ id: 9, qty: 2 }, { id: 15, qty: 2 }], "One chai without sugar", "Preparing", "hina.malik", 7, 0.2);
    mk(3, [{ id: 10, qty: 1 }, { id: 5, qty: 2 }], "No mayo in the sandwich", "Preparing", "m.usman", 5, 0);
    db.billRequested = { 9: t - 4 * 60000 };
    return db;
  }

  // ------------------------------------------------------------------ kitchen simulation
  const KDS_KEY = "cms_kds_heartbeat";
  function kitchenOnline() { try { return now() - Number(localStorage.getItem(KDS_KEY) || 0) < 15000; } catch (e) { return false; } }
  function tick() {
    // Simulate the kitchen only when no kitchen user has the display open
    if (!db || !db.settings.kitchenSim || kitchenOnline()) return;
    const t = now(), changed = [];
    db.orders.forEach(function (o) {
      if (o.status === "Placed" && t - o.updatedAt >= SIM.toPreparing) { o.status = "Preparing"; o.updatedAt = t; changed.push(o); }
      else if (o.status === "Preparing" && t - o.updatedAt >= SIM.toReady) { o.status = "Ready"; o.updatedAt = t; changed.push(o); }
    });
    if (changed.length) commit(changed);
  }

  // ------------------------------------------------------------------ public API
  const Store = {
    TAX_RATE: TAX_RATE, ROLES: ROLES, TABLES: TABLES, ACTIVE: ACTIVE, DISCOUNT_LIMIT: DISCOUNT_LIMIT,

    init: function () {
      if (db) return;
      db = load();
      if (!db || db.v !== 3) { seed(); persist(); }
      tick();
      setInterval(tick, 1000);
      window.addEventListener("storage", function (e) { if (e.key === DB_KEY && e.newValue) { db = JSON.parse(e.newValue); emit(); } });
    },
    on: function (fn) { listeners.push(fn); },
    reset: function (by) { seed(); log(by, "Demo data reset", "All demo data restored to defaults", "warning"); commit(); },
    totals: totals,
    log: function (user, action, details, severity) { log(user, action, details, severity); commit(); },

    // ---- users
    findUser: function (u) { const x = findUser(u); return x ? clone(x) : null; },
    users: function () { return clone(db.users); },
    recordLogin: function (username) { const u = findUser(username); u.lastLogin = now(); log(username, "Signed in", u.role + " session started", "info"); commit(); },
    addUser: function (data, by) {
      const username = String(data.username || "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9._]{2,29}$/.test(username)) fail("Username must be 3–30 characters: letters, numbers, dots or underscores, starting with a letter.");
      if (findUser(username)) fail("That username is already taken.");
      const name = String(data.name || "").trim();
      if (name.length < 2 || name.length > 60) fail("Enter the staff member's full name (2–60 characters).");
      if (ROLES.indexOf(data.role) === -1) fail("Choose a valid role.");
      db.users.push({ username: username, name: name, role: data.role, status: "Active", lastLogin: null });
      log(by, "User created", username + " · " + data.role, "warning");
      commit();
    },
    setRole: function (username, role, by) {
      const u = findUser(username);
      if (!u || ROLES.indexOf(role) === -1) fail("Invalid user or role.");
      if (username === by) fail("You can't change your own role. Ask another admin.");
      if (u.role === "Admin" && role !== "Admin" && db.users.filter(function (x) { return x.role === "Admin" && x.status === "Active"; }).length < 2) fail("There must always be at least one active admin.");
      const old = u.role; u.role = role;
      log(by, "Role changed", username + ": " + old + " → " + role, "high");
      commit();
    },
    setStatus: function (username, status, by) {
      const u = findUser(username);
      if (!u) fail("User not found.");
      if (username === by) fail("You can't disable your own account.");
      u.status = status;
      log(by, status === "Disabled" ? "Account disabled" : "Account enabled", username + " (" + u.role + ")", "high");
      commit();
    },

    // ---- menu
    menu: function () { return clone(db.menu); },
    menuItem: function (id) { const m = menuItem(id); return m ? clone(m) : null; },
    categories: function () { return Array.from(new Set(db.menu.map(function (m) { return m.cat; }))); },
    isAvailable: function (id) { const m = menuItem(id); return !!m && !unavailableReason(m); },
    unavailableReason: function (id) { const m = menuItem(id); return m ? unavailableReason(m) : "Removed"; },
    saveMenuItem: function (data, by) {
      const name = String(data.name || "").trim(), desc = String(data.desc || "").trim(), cat = String(data.cat || "").trim();
      const price = Number(data.price);
      if (name.length < 2 || name.length > 40) fail("Item name must be 2–40 characters.");
      if (!cat || cat.length > 24) fail("Choose or enter a category.");
      if (!Number.isInteger(price) || price < 50 || price > 20000) fail("Price must be a whole number between Rs 50 and Rs 20,000.");
      if (desc.length > 80) fail("Description must be 80 characters or fewer.");
      if (db.menu.some(function (m) { return m.name.toLowerCase() === name.toLowerCase() && m.id !== data.id; })) fail("An item with this name already exists.");
      if (data.id) {
        const m = menuItem(data.id);
        if (m.price !== price) log(by, "Price changed", m.name + ": Rs " + m.price + " → Rs " + price, "warning");
        if (m.available !== !!data.available) log(by, data.available ? "Item switched on" : "Item switched off", name, "info");
        if (m.name !== name || m.cat !== cat || m.desc !== desc) log(by, "Menu item edited", name, "info");
        Object.assign(m, { name: name, cat: cat, price: price, desc: desc, available: !!data.available });
      } else {
        db.menu.push({ id: ++db.seq.menu, name: name, cat: cat, price: price, desc: desc, available: !!data.available, recipe: [] });
        log(by, "Menu item added", name + " · " + cat + " · Rs " + price, "warning");
      }
      commit();
    },
    deleteMenuItem: function (id, by) {
      const m = menuItem(id);
      if (!m) return;
      if (db.orders.some(function (o) { return !o.billed && o.status !== "Cancelled" && o.items.some(function (i) { return i.id === id; }); })) fail("This item is on an open order. Remove it after the table has paid.");
      db.menu = db.menu.filter(function (x) { return x.id !== id; });
      log(by, "Menu item deleted", m.name + " · Rs " + m.price, "high");
      commit();
    },

    // ---- inventory
    inventory: function () { return clone(db.inventory); },
    stockStatus: function (id) { return stockStatus(ingredient(id)); },
    lowStock: function () { return clone(db.inventory.filter(function (i) { return stockStatus(i) !== "ok"; })); },
    usedIn: function (ingId) { return db.menu.filter(function (m) { return (m.recipe || []).some(function (r) { return r.ing === ingId; }); }).map(function (m) { return m.name; }); },
    adjustStock: function (id, delta, reason, by) {
      const ing = ingredient(id);
      const d = Number(delta);
      if (!ing) fail("Item not found.");
      if (!isFinite(d) || d === 0 || Math.abs(d) > 1000) fail("Enter a quantity between 0 and 1000.");
      if (ing.qty + d < 0) fail("Stock can't go below zero.");
      if (!reason || reason.length > 60) fail("Add a short reason (up to 60 characters).");
      ing.qty = round2(ing.qty + d);
      log(by, d > 0 ? "Stock restocked" : "Stock written off", ing.name + " " + (d > 0 ? "+" : "") + d + " " + ing.unit + " · " + reason, d > 0 ? "info" : "warning");
      commit();
    },

    // ---- orders
    orders: function () { return clone(db.orders).sort(function (a, b) { return b.createdAt - a.createdAt; }); },
    order: function (id) { const o = db.orders.find(function (x) { return x.id === id; }); return o ? clone(o) : null; },
    place: function (table, lines, notes, by) {
      if (!TABLES.some(function (t) { return t.no === table; })) fail("Choose a valid table.");
      if (!lines.length) fail("Add at least one item.");
      const st = Store.tableState(table, by);
      if (st.state === "other") fail("Table " + table + " is being served by another waiter.");
      const bad = lines.find(function (l) { return !Store.isAvailable(l.id); });
      if (bad) fail(menuItem(bad.id).name + " is no longer available.");
      const o = { id: "ORD-" + (++db.seq.order), table: table, items: snapshot(lines), notes: String(notes || "").slice(0, 120), status: "Placed",
        waiter: by, createdAt: now(), updatedAt: now(), billed: false };
      stockDelta(lines, -1);
      db.orders.push(o);
      delete db.billRequested[table];
      commit([o]);
      return clone(o);
    },
    updateOrder: function (id, lines, notes, by) {
      const o = db.orders.find(function (x) { return x.id === id; });
      if (!o) fail("Order not found.");
      if (o.waiter !== by) fail("You can only edit your own orders.");
      if (o.status !== "Placed") fail("The kitchen has already started " + id + ". Send a new order for extra items.");
      if (!lines.length) fail("An order needs at least one item. Cancel it instead.");
      stockDelta(o.items, +1);
      const bad = lines.find(function (l) { return !Store.isAvailable(l.id); });
      if (bad) { stockDelta(o.items, -1); fail(menuItem(bad.id).name + " is no longer available."); }
      stockDelta(lines, -1);
      o.items = snapshot(lines); o.notes = String(notes || "").slice(0, 120); o.updatedAt = now();
      log(by, "Order updated", id + " · Table " + o.table, "info");
      commit([o]);
      return clone(o);
    },
    setOrderStatus: function (id, status, by) {
      const o = db.orders.find(function (x) { return x.id === id; });
      if (!o) fail("Order not found.");
      const flow = { Placed: ["Preparing", "Cancelled"], Preparing: ["Ready"], Ready: ["Served"], Served: [], Cancelled: [] };
      if (flow[o.status].indexOf(status) === -1) fail(id + " is already " + o.status.toLowerCase() + ".");
      o.status = status; o.updatedAt = now();
      if (status === "Cancelled") { stockDelta(o.items, +1); log(by, "Order cancelled", id + " · Table " + o.table, "warning"); }
      commit([o]);
      return clone(o);
    },

    // ---- tables
    tableState: function (no, username) {
      const open = openOrdersOn(no);
      if (!open.length) return { state: "free", label: "Free" };
      const others = open.some(function (o) { return o.waiter !== username; });
      if (others) return { state: "other", label: "Other staff" };
      if (db.billRequested[no]) return { state: "bill", label: "Bill requested", orders: clone(open) };
      if (open.some(function (o) { return o.status === "Ready"; })) return { state: "ready", label: "Order ready", orders: clone(open) };
      if (open.every(function (o) { return o.status === "Served"; })) return { state: "mine", label: "Served", served: true, orders: clone(open) };
      return { state: "mine", label: "In progress", orders: clone(open) };
    },
    requestBill: function (no, by) {
      const open = openOrdersOn(no);
      if (!open.length) fail("There are no open orders on Table " + no + ".");
      if (!open.every(function (o) { return o.status === "Served"; })) fail("Serve every order on Table " + no + " before requesting the bill.");
      db.billRequested[no] = now();
      log(by, "Bill requested", "Table " + no, "info");
      commit();
    },
    openTables: function () {
      return TABLES.map(function (t) {
        const open = openOrdersOn(t.no);
        if (!open.length) return null;
        const lines = [];
        open.forEach(function (o) { o.items.forEach(function (i) {
          const ex = lines.find(function (l) { return l.id === i.id && l.price === i.price; });
          if (ex) ex.qty += i.qty; else lines.push({ id: i.id, name: i.name, price: i.price, qty: i.qty });
        }); });
        return { no: t.no, seats: t.seats, orders: clone(open), lines: lines, allServed: open.every(function (o) { return o.status === "Served"; }),
          billRequested: db.billRequested[t.no] || null, waiters: Array.from(new Set(open.map(function (o) { const u = findUser(o.waiter); return u ? u.name : o.waiter; }))),
          since: Math.min.apply(null, open.map(function (o) { return o.createdAt; })), totals: totals(lines, 0) };
      }).filter(Boolean);
    },

    // ---- billing
    pay: function (no, opts, by) {
      const tab = Store.openTables().find(function (t) { return t.no === no; });
      const u = findUser(by);
      if (!tab) fail("Table " + no + " has nothing to bill.");
      if (!tab.allServed) fail("Some orders on Table " + no + " haven't been served yet.");
      const pct = Number(opts.discountPct || 0);
      const limit = DISCOUNT_LIMIT[u.role] || 0;
      if (!(pct >= 0 && pct <= limit)) fail("Your role can apply a discount of up to " + limit + "%. Ask a manager for more.");
      if (["Cash", "Card", "Wallet"].indexOf(opts.method) === -1) fail("Choose a payment method.");
      const tt = totals(tab.lines, pct);
      const tendered = opts.method === "Cash" ? Number(opts.tendered) : tt.total;
      if (opts.method === "Cash" && !(tendered >= tt.total)) fail("Cash received must be at least Rs " + tt.total.toLocaleString() + ".");
      const bill = { no: "B-" + (++db.seq.bill), table: no, orderIds: tab.orders.map(function (o) { return o.id; }), lines: tab.lines, discountPct: pct,
        subtotal: tt.sub, discount: tt.discount, tax: tt.tax, total: tt.total, method: opts.method, tendered: tendered, change: tendered - tt.total,
        cashier: by, createdAt: now(), status: "Paid" };
      db.bills.push(bill);
      db.orders.forEach(function (o) { if (bill.orderIds.indexOf(o.id) !== -1) { o.billed = true; o.billNo = bill.no; } });
      delete db.billRequested[no];
      log(by, "Payment recorded", bill.no + " · Table " + no + " · Rs " + bill.total.toLocaleString() + " · " + bill.method, "info");
      if (pct) log(by, "Discount applied", bill.no + " · " + pct + "% (Rs " + tt.discount.toLocaleString() + ")", pct > 10 ? "high" : "warning");
      commit();
      return clone(bill);
    },
    bills: function () { return clone(db.bills).sort(function (a, b) { return b.createdAt - a.createdAt; }); },
    bill: function (no) { const b = db.bills.find(function (x) { return x.no === no; }); return b ? clone(b) : null; },
    refund: function (no, reason, by) {
      const u = findUser(by);
      if (!u || ["Manager", "Admin"].indexOf(u.role) === -1) fail("Only a manager can issue refunds.");
      const b = db.bills.find(function (x) { return x.no === no; });
      if (!b) fail("Bill not found.");
      if (b.status === "Refunded") fail(no + " has already been refunded.");
      reason = String(reason || "").trim();
      if (reason.length < 4 || reason.length > 80) fail("Give a reason for the refund (4–80 characters).");
      b.status = "Refunded"; b.refund = { by: by, at: now(), reason: reason };
      log(by, "Refund issued", no + " · Rs " + b.total.toLocaleString() + " · " + reason, "high");
      commit();
    },

    // ---- reports
    salesToday: function () {
      const today = db.bills.filter(function (b) { return isToday(b.createdAt); });
      const paid = today.filter(function (b) { return b.status === "Paid"; });
      const refunded = today.filter(function (b) { return b.status === "Refunded"; });
      const byHour = new Array(24).fill(0), byMethod = { Cash: 0, Card: 0, Wallet: 0 }, byCat = {}, items = {};
      let qty = 0;
      paid.forEach(function (b) {
        byHour[new Date(b.createdAt).getHours()] += b.total;
        byMethod[b.method] = (byMethod[b.method] || 0) + b.total;
        b.lines.forEach(function (l) {
          qty += l.qty;
          const m = menuItem(l.id); const cat = m ? m.cat : (l.cat || "Other");
          byCat[cat] = (byCat[cat] || 0) + l.price * l.qty;
          items[l.name] = items[l.name] || { name: l.name, qty: 0, revenue: 0 };
          items[l.name].qty += l.qty; items[l.name].revenue += l.price * l.qty;
        });
      });
      const revenue = paid.reduce(function (s, b) { return s + b.total; }, 0);
      return {
        revenue: revenue, bills: paid.length, avg: paid.length ? Math.round(revenue / paid.length) : 0, items: qty,
        refunds: refunded.length, refundAmount: refunded.reduce(function (s, b) { return s + b.total; }, 0),
        discounts: paid.reduce(function (s, b) { return s + b.discount; }, 0), tax: paid.reduce(function (s, b) { return s + b.tax; }, 0),
        byHour: byHour, byMethod: byMethod, byCat: byCat,
        top: Object.keys(items).map(function (k) { return items[k]; }).sort(function (a, b) { return b.qty - a.qty; }).slice(0, 6)
      };
    },

    // ---- audit
    auditLog: function () { return clone(db.audit).reverse(); },
    verifyAudit: function () {
      let prev = "00000000";
      for (let i = 0; i < db.audit.length; i++) {
        const e = db.audit[i];
        if (e.prev !== prev || entryHash(e) !== e.hash) return { ok: false, brokenAt: e.id, count: db.audit.length };
        prev = e.hash;
      }
      return { ok: true, count: db.audit.length };
    },

    // ---- settings
    kitchenHeartbeat: function () { try { localStorage.setItem(KDS_KEY, String(now())); } catch (e) {} },
    kitchenOnline: kitchenOnline,
    settings: function () { return clone(db.settings); },
    setSetting: function (key, value, by) {
      db.settings[key] = value;
      log(by, "Setting changed", key + " = " + value, "info");
      commit();
    }
  };

  window.Store = Store;
})();
