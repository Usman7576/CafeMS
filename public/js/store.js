// Thin client for the server API. It holds no rules and stores nothing on the device: reads come
// from a role-filtered copy in memory, refreshed from the server; every change goes to the server,
// which decides whether it is allowed. Tampering with this file only changes what one screen shows.
(function () {
  const ROLES = ["Waiter", "Kitchen", "Cashier", "Manager", "Admin"];
  const REFRESH_MS = 3000;
  const DATE_KEYS = new Set(["createdAt", "updatedAt", "since", "billRequested", "at", "lastLogin", "expiresAt", "loginAt", "lastSeenAt"]);

  let data = null;
  let lastJson = "";
  let online = true;
  let started = false;
  const listeners = [];
  const intentKeys = new Map();
  let resolveReady;
  const readyPromise = new Promise(function (resolve) { resolveReady = resolve; });

  // Dates arrive as text; the screens work with millisecond timestamps
  function normalize(value, key) {
    if (Array.isArray(value)) return value.map(function (v) { return normalize(v); });
    if (value && typeof value === "object") {
      const out = {};
      Object.keys(value).forEach(function (k) { out[k] = normalize(value[k], k); });
      return out;
    }
    if (DATE_KEYS.has(key) && typeof value === "string") return Date.parse(value);
    return value;
  }

  function sessionEnded() {
    Session.clear();
    Session.flash("Your session has ended. Please sign in again.");
    window.location.replace("login.html");
  }

  // Finds orders that changed since the last refresh, so the shell can alert the user
  function changedOrders(previous, next) {
    if (!previous) return [];
    const list = function (d) { return d.orders || d.tickets || []; };
    const before = new Map(list(previous).map(function (o) { return [o.id, o.status]; }));
    return list(next).filter(function (o) { return before.get(o.id) !== o.status; });
  }

  async function refresh(background) {
    const snapshot = await Api.call("GET", "/snapshot", undefined, background ? { headers: { "X-Background-Refresh": "1" } } : {});
    const json = JSON.stringify(snapshot);
    if (json === lastJson) return;
    lastJson = json;
    const previous = data;
    data = normalize(snapshot);
    const changed = changedOrders(previous, data);
    if (previous) listeners.forEach(function (fn) { try { fn(changed); } catch (e) { console.error(e); } });
  }

  function poll() {
    if (document.hidden) return;
    refresh(true).then(function () {
      if (!online) CMS.toast("Connection restored", "ok");
      online = true;
    }).catch(function (e) {
      if (e.status === 401) { sessionEnded(); return; }
      if (online) CMS.toast("Connection to the server was lost. Showing the last known data.", "err");
      online = false;
    });
  }

  // Runs a change, then refreshes so the screen shows what the server now holds
  async function change(method, path, body, opts) {
    const result = await Api.call(method, path, body, opts);
    await refresh().catch(function () {});
    return result;
  }

  // One intent keeps one key until the server gives a final answer. A double click, or a retry after
  // a network failure, therefore cannot create a second order, payment or refund.
  function randomKey() { return crypto.randomUUID().replace(/-/g, ""); }
  async function changeOnce(method, path, body) {
    const intent = method + path + JSON.stringify(body);
    if (!intentKeys.has(intent)) intentKeys.set(intent, randomKey());
    try {
      const result = await change(method, path, body, { headers: { "Idempotency-Key": intentKeys.get(intent) } });
      intentKeys.delete(intent);
      return result;
    } catch (error) {
      if (error.status) intentKeys.delete(intent);
      throw error;
    }
  }

  const list = function (key) { return (data && data[key]) || []; };
  const copy = function (value) { return JSON.parse(JSON.stringify(value)); };
  const findMenu = function (id) { return list("menu").find(function (m) { return m.id === id; }); };
  const constants = function () { return (data && data.constants) || { tables: [], activeStatuses: [], taxRate: 0.16, discountLimit: 0 }; };

  function totals(lines, discountPct) {
    // For display while choosing. The server recalculates every amount it stores.
    const sub = lines.reduce(function (s, l) { return s + l.price * l.qty; }, 0);
    const discount = Math.round(sub * (discountPct || 0) / 100);
    const tax = Math.round((sub - discount) * constants().taxRate);
    return { sub: sub, discount: discount, tax: tax, total: sub - discount + tax, count: lines.reduce(function (s, l) { return s + l.qty; }, 0) };
  }

  const Store = {
    ROLES: ROLES,
    get TABLES() { return constants().tables; },
    get ACTIVE() { return constants().activeStatuses; },
    get discountLimit() { return constants().discountLimit; },
    init: function () {
      if (started) return;
      started = true;
      refresh().then(resolveReady).catch(function (e) {
        if (e.status === 401) { sessionEnded(); return; }
        CMS.toast(e.userMessage || "Could not load data from the server.", "err");
      });
      setInterval(poll, REFRESH_MS);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
    },
    whenReady: function () { return readyPromise; },
    on: function (fn) { listeners.push(fn); },
    totals: totals,

    // ---- reads
    menu: function () { return copy(list("menu")); },
    menuItem: function (id) { const m = findMenu(id); return m ? copy(m) : null; },
    categories: function () { return Array.from(new Set(list("menu").map(function (m) { return m.cat; }))); },
    isAvailable: function (id) { const m = findMenu(id); return !!m && !m.reason; },
    unavailableReason: function (id) { const m = findMenu(id); return m ? m.reason : "Removed"; },
    orders: function () { return copy(list("orders")); },
    order: function (id) { const o = list("orders").find(function (x) { return x.id === id; }); return o ? copy(o) : null; },
    tickets: function () { return copy(list("tickets")); },
    tableState: function (no) {
      const t = list("tables").find(function (x) { return x.no === no; });
      if (!t) return { state: "free", label: "Free" };
      return Object.assign(copy(t), { orders: (t.orderIds || []).map(Store.order).filter(Boolean) });
    },
    openTables: function () { return copy(list("openTables")); },
    bills: function () { return copy(list("bills")); },
    bill: function (no) { const b = list("bills").find(function (x) { return x.no === no; }); return b ? copy(b) : null; },
    staffName: function (username) { const names = (data && data.staffNames) || {}; return Object.prototype.hasOwnProperty.call(names, username) ? names[username] : username; },
    inventory: function () { return copy(list("inventory")); },
    lowStock: function () { return copy(list("inventory").filter(function (i) { return i.status !== "ok"; })); },
    salesToday: function () { return copy(data.sales); },
    reservations: function () { return copy(list("reservations")); },
    users: function () { return copy(list("users")); },
    approvals: function () { return copy(list("approvals")); },
    recentAudit: function () { return copy(list("recentAudit")); },
    cafe: function () { return copy((data && data.cafe) || { name: "CafeMS" }); },
    alerts: function () { return copy(list("alerts")); },
    photoUrl: function (id) { return "/api/v1/menu/" + id + "/photo"; },

    // ---- server queries
    searchReservationsByPhone: async function (phone) {
      const result = await Api.call("POST", "/reservations/search", { phone: phone });
      return normalize(result.reservations);
    },
    auditEntries: async function (severity) {
      const query = severity && severity !== "all" ? "&severity=" + encodeURIComponent(severity) : "";
      const result = await Api.call("GET", "/audit?limit=200" + query);
      return normalize(result.entries);
    },
    verifyAudit: function () { return Api.call("GET", "/audit/verify"); },
    reviewAudit: function (note) { return Api.call("POST", "/audit/review", { note: note }); },
    billPhone: async function (no) { return (await Api.call("GET", "/bills/" + encodeURIComponent(no) + "/phone")).phone; },
    reservationPhone: async function (id) { return (await Api.call("GET", "/reservations/" + encodeURIComponent(id) + "/phone")).phone; },

    // ---- changes
    place: function (table, lines, notes) { return changeOnce("POST", "/orders", { table: table, lines: lines, notes: notes }); },
    updateOrder: function (id, lines, notes) {
      const current = Store.order(id);
      return change("PUT", "/orders/" + encodeURIComponent(id), { version: current ? current.version : 0, lines: lines, notes: notes });
    },
    serve: function (id) { return change("POST", "/orders/" + encodeURIComponent(id) + "/serve", {}); },
    cancel: function (id) { return change("POST", "/orders/" + encodeURIComponent(id) + "/cancel", {}); },
    requestBill: function (no) { return change("POST", "/tables/" + no + "/request-bill", {}); },
    setTicketStatus: function (id, status) { return change("POST", "/kitchen/tickets/" + encodeURIComponent(id) + "/status", { status: status }); },
    pay: function (no, opts) {
      const body = { discountPct: opts.discountPct, method: opts.method, phone: String(opts.phone || "").trim() };
      if (opts.method === "Cash") body.tendered = Number(opts.tendered);
      return changeOnce("POST", "/billing/tables/" + no + "/pay", body);
    },
    retryPayment: function (no, body) { return change("POST", "/bills/" + encodeURIComponent(no) + "/retry-payment", body || {}); },
    acknowledgeAlert: function (id) { return change("POST", "/alerts/" + encodeURIComponent(id) + "/acknowledge", {}); },
    eraseCustomer: function (phone) { return change("POST", "/customers/erase", { phone: phone }); },
    uploadPhoto: async function (id, file) { await Api.upload("/menu/" + id + "/photo", file); await refresh().catch(function () {}); },
    refund: function (no, reason) { return changeOnce("POST", "/bills/" + encodeURIComponent(no) + "/refund", { reason: String(reason || "") }); },
    decideApproval: function (id, decision) { return change("POST", "/approvals/" + encodeURIComponent(id) + "/" + decision, {}); },
    addReservation: function (d) {
      return changeOnce("POST", "/reservations", { name: d.name, phone: d.phone, date: d.date, time: d.time, party: Number(d.party), notes: d.notes });
    },
    updateReservation: function (id, status) { return change("POST", "/reservations/" + encodeURIComponent(id) + "/status", { status: status }); },
    saveMenuItem: function (d) {
      const body = { name: d.name, cat: d.cat, price: d.price, desc: d.desc, available: d.available };
      if (d.recipeEdit) body.recipe = d.recipeEdit;
      return d.id ? change("PUT", "/menu/" + d.id, body) : change("POST", "/menu", body);
    },
    deleteMenuItem: function (id) { return change("DELETE", "/menu/" + id); },
    adjustStock: function (id, delta, reason) { return change("POST", "/inventory/" + id + "/adjust", { delta: delta, reason: reason }); },
    inviteUser: function (d) { return change("POST", "/users/invitations", { username: d.username, name: d.name, role: d.role }); },
    setRole: function (username, role) { return change("POST", "/users/" + encodeURIComponent(username) + "/role", { role: role }); },
    setStatus: function (username, status) { return change("POST", "/users/" + encodeURIComponent(username) + "/status", { status: status }); },
    resetUser: function (username) { return change("POST", "/users/" + encodeURIComponent(username) + "/reset-link", {}); },
    unlockUser: function (username) { return change("POST", "/users/" + encodeURIComponent(username) + "/unlock", {}); },
    saveCafe: function (details) { return change("PUT", "/settings/cafe", details); },
    salesFor: function (date) { return Api.call("GET", "/reports/sales?date=" + encodeURIComponent(date)); },
    billsFor: async function (date) { return normalize((await Api.call("GET", "/bills?date=" + encodeURIComponent(date))).bills); },
    trend: async function () { return (await Api.call("GET", "/reports/trend")).days; },
    risk: function () { return Api.call("GET", "/risk"); }
  };

  window.Store = Store;
})();
