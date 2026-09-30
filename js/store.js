// Prototype data layer. In the final system this is replaced by calls to the
// backend REST API (Node.js/Express), which enforces RBAC on every request.
(function () {
  const TAX_RATE = 0.16;

  const MENU = [
    { id: 1,  name: "Espresso",              cat: "Coffee",      price: 350, desc: "Double shot, rich crema.", available: true },
    { id: 2,  name: "Cappuccino",            cat: "Coffee",      price: 520, desc: "Espresso, steamed milk, thick foam.", available: true },
    { id: 3,  name: "Caffè Latte",           cat: "Coffee",      price: 550, desc: "Smooth espresso with silky milk.", available: true },
    { id: 4,  name: "Caramel Macchiato",     cat: "Coffee",      price: 650, desc: "Vanilla, milk, espresso, caramel drizzle.", available: true },
    { id: 5,  name: "Iced Americano",        cat: "Cold Drinks", price: 480, desc: "Espresso over ice and cold water.", available: true },
    { id: 6,  name: "Mango Smoothie",        cat: "Cold Drinks", price: 590, desc: "Fresh mango, yoghurt, honey.", available: false },
    { id: 7,  name: "Fresh Lime Soda",       cat: "Cold Drinks", price: 300, desc: "Sweet or salted.", available: true },
    { id: 8,  name: "Green Tea",             cat: "Tea",         price: 250, desc: "Jasmine green tea, pot for one.", available: true },
    { id: 9,  name: "Karak Chai",            cat: "Tea",         price: 220, desc: "Strong spiced milk tea.", available: true },
    { id: 10, name: "Chicken Club Sandwich", cat: "Food",        price: 890, desc: "Grilled chicken, egg, served with fries.", available: true },
    { id: 11, name: "Grilled Panini",        cat: "Food",        price: 820, desc: "Mozzarella, pesto, sun-dried tomato.", available: true },
    { id: 12, name: "Loaded Fries",          cat: "Food",        price: 560, desc: "Cheese sauce, jalapeños, spring onion.", available: true },
    { id: 13, name: "Chocolate Brownie",     cat: "Desserts",    price: 420, desc: "Warm, with chocolate sauce.", available: true },
    { id: 14, name: "Blueberry Cheesecake",  cat: "Desserts",    price: 690, desc: "Baked New York style.", available: false },
    { id: 15, name: "Butter Croissant",      cat: "Desserts",    price: 380, desc: "Freshly baked every morning.", available: true }
  ];

  const TABLES = [
    { no: 1, seats: 2 }, { no: 2, seats: 2 }, { no: 3, seats: 4 }, { no: 4, seats: 4 }, { no: 5, seats: 4 },
    { no: 6, seats: 4 }, { no: 7, seats: 6 }, { no: 8, seats: 2 }, { no: 9, seats: 4 }, { no: 10, seats: 8 }
  ];
  // Tables served by other staff this shift. A waiter sees only that they're busy, never their order details.
  const OTHER_STAFF_TABLES = [4, 9];

  // Kitchen simulation timings (ms). Later, Kitchen Staff update status from their own screen.
  const TO_PREPARING = 8000;
  const TO_READY = 16000;

  const KEY = "cms_orders";
  const ACTIVE = ["Placed", "Preparing", "Ready"];
  let orders = [];
  const listeners = [];

  function load() { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { return null; } }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(orders)); } catch (e) {} }
  function emit(changed) { listeners.forEach(function (fn) { fn(changed || []); }); }

  function menuItem(id) { return MENU.find(function (m) { return m.id === id; }); }

  function totals(items) {
    const sub = items.reduce(function (s, it) { return s + it.price * it.qty; }, 0);
    const tax = Math.round(sub * TAX_RATE);
    return { sub: sub, tax: tax, total: sub + tax, count: items.reduce(function (s, it) { return s + it.qty; }, 0) };
  }

  function snapshot(lines) {
    return lines.map(function (l) { const m = menuItem(l.id); return { id: m.id, name: m.name, price: m.price, qty: l.qty }; });
  }

  // Seed a realistic shift so the dashboard isn't empty on first sign-in.
  function seed(user) {
    const now = Date.now();
    const mk = function (id, table, lines, notes, status, minsAgo, updMinsAgo) {
      const items = snapshot(lines);
      return { id: id, table: table, items: items, notes: notes, status: status, waiter: user,
        createdAt: now - minsAgo * 60000, updatedAt: now - updMinsAgo * 60000, total: totals(items).total, cleared: false };
    };
    orders = [
      mk("ORD-1041", 1, [{ id: 3, qty: 1 }, { id: 15, qty: 1 }], "", "Served", 48, 36),
      mk("ORD-1042", 1, [{ id: 1, qty: 1 }], "", "Served", 42, 38),
      mk("ORD-1043", 6, [{ id: 2, qty: 2 }, { id: 13, qty: 2 }], "", "Served", 31, 20),
      mk("ORD-1044", 3, [{ id: 10, qty: 1 }, { id: 5, qty: 2 }], "No mayo in the sandwich", "Preparing", 4, 0),
      mk("ORD-1045", 7, [{ id: 12, qty: 2 }, { id: 7, qty: 3 }, { id: 11, qty: 1 }], "", "Ready", 14, 1)
    ];
    orders[0].cleared = orders[1].cleared = true;
    save();
  }

  function tick() {
    const now = Date.now();
    const changed = [];
    orders.forEach(function (o) {
      if (o.status === "Placed" && now - o.updatedAt >= TO_PREPARING) {
        o.status = "Preparing"; o.updatedAt = now; changed.push(o);
      } else if (o.status === "Preparing" && now - o.updatedAt >= TO_READY) {
        o.status = "Ready"; o.updatedAt = now; changed.push(o);
      }
    });
    if (changed.length) { save(); emit(changed); }
  }

  function nextId() {
    const max = orders.reduce(function (m, o) { return Math.max(m, parseInt(o.id.split("-")[1], 10) || 0); }, 1040);
    return "ORD-" + (max + 1);
  }

  const Store = {
    TAX_RATE: TAX_RATE, MENU: MENU, TABLES: TABLES, ACTIVE: ACTIVE,
    init: function (user) {
      const saved = load();
      if (saved && saved.length) orders = saved; else seed(user);
      tick();
      setInterval(tick, 1000);
      window.addEventListener("storage", function (e) { if (e.key === KEY) { orders = load() || []; emit(); } });
    },
    on: function (fn) { listeners.push(fn); },
    menuItem: menuItem,
    totals: totals,
    all: function () { return orders.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }); },
    get: function (id) { return orders.find(function (o) { return o.id === id; }); },
    active: function () { return this.all().filter(function (o) { return ACTIVE.indexOf(o.status) !== -1; }); },
    byStatus: function (s) { return this.all().filter(function (o) { return o.status === s; }); },

    place: function (table, lines, notes, user) {
      const items = snapshot(lines);
      const o = { id: nextId(), table: table, items: items, notes: notes, status: "Placed", waiter: user,
        createdAt: Date.now(), updatedAt: Date.now(), total: totals(items).total, cleared: false };
      orders.push(o); save(); emit([o]);
      return o;
    },
    setStatus: function (id, status) {
      const o = this.get(id);
      if (!o) return null;
      o.status = status; o.updatedAt = Date.now();
      save(); emit([o]);
      return o;
    },
    clearTable: function (no) {
      orders.forEach(function (o) { if (o.table === no) o.cleared = true; });
      save(); emit();
    },

    // Table state from this waiter's point of view.
    tableState: function (no) {
      if (OTHER_STAFF_TABLES.indexOf(no) !== -1) return { state: "other", label: "Other staff" };
      const mine = orders.filter(function (o) { return o.table === no && !o.cleared && o.status !== "Cancelled"; });
      if (!mine.length) return { state: "free", label: "Free" };
      if (mine.some(function (o) { return o.status === "Ready"; })) return { state: "ready", label: "Order ready", orders: mine };
      if (mine.every(function (o) { return o.status === "Served"; })) return { state: "mine", label: "Served", served: true, orders: mine };
      return { state: "mine", label: "In progress", orders: mine };
    },

    stats: function () {
      const all = orders;
      const served = all.filter(function (o) { return o.status === "Served"; });
      const busy = TABLES.filter(function (t) { const s = Store.tableState(t.no).state; return s !== "free"; }).length;
      return {
        active: all.filter(function (o) { return o.status === "Placed" || o.status === "Preparing"; }).length,
        ready: all.filter(function (o) { return o.status === "Ready"; }).length,
        served: served.length,
        tablesBusy: busy,
        tablesTotal: TABLES.length
      };
    }
  };

  window.Store = Store;
})();
