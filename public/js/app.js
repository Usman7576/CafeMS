// Staff app shell: session guard, role-based navigation (RBAC — UX layer only), sidebar grouped by
// kind of work, top bar with live status, notifications, command palette (Ctrl/⌘+K), user menu with
// PIN switching, and the inactivity timeout. Each staff page only contains its <main> content.
(function () {
  const PAGES = {
    dashboard: { title: "Dashboard",       roles: ["Waiter"] },
    order:     { title: "POS",             roles: ["Waiter", "Cashier"] },
    reservation: { title: "New reservation", roles: ["Waiter", "Manager"] },
    reservations: { title: "Reservations", roles: ["Waiter", "Manager"] },
    requests:  { title: "Staff requests",  roles: ["Waiter", "Barista", "Kitchen", "Cashier", "Manager"] },
    kitchen:   { title: "Kitchen display", roles: ["Kitchen", "Barista"] },
    billing:   { title: "Billing",         roles: ["Cashier", "Manager"] },
    overview:  { title: "Overview",        roles: ["Manager", "Admin"] },
    inventory: { title: "Inventory",       roles: ["Manager"] },
    reports:   { title: "Sales reports",   roles: ["Manager", "Admin"] },
    menu:      { title: "Menu",            roles: ["Admin"] },
    users:     { title: "Staff & roles",   roles: ["Admin"] },
    settings:  { title: "Settings",        roles: ["Admin"] },
    guests:    { title: "Guests",          roles: ["Manager", "Admin"] },
    insights:  { title: "Insights",        roles: ["Manager", "Admin"] },
    team:      { title: "Team",            roles: ["Waiter", "Barista", "Kitchen", "Cashier", "Manager", "Admin"] },
    audit:     { title: "Audit log",       roles: ["Admin"] },
    security:  { title: "Security",        roles: ["Admin"] },
    account:   { title: "My account",      roles: ["Waiter", "Barista", "Kitchen", "Cashier", "Manager", "Admin"] }
  };
  const HOME = { Waiter: "dashboard.html", Barista: "kitchen.html", Kitchen: "kitchen.html", Cashier: "billing.html", Manager: "overview.html", Admin: "overview.html" };
  const L = {
    dashboard: { page: "dashboard", href: "dashboard.html", icon: "dashboard", label: "Dashboard" },
    order: { page: "order", href: "order.html", icon: "plus", label: "POS" },
    tables: { href: "dashboard.html#floor", icon: "grid", label: "Tables" },
    ready: { href: "dashboard.html#ready", icon: "bell", label: "Ready to serve", badge: true },
    kitchen: { page: "kitchen", href: "kitchen.html", icon: "chef", label: "Kitchen display", badge: true },
    bar: { page: "kitchen", href: "kitchen.html", icon: "coffee", label: "Bar display", badge: true },
    billing: { page: "billing", href: "billing.html", icon: "receipt", label: "Billing" },
    reservation: { page: "reservation", href: "reservation.html", icon: "calendar", label: "New reservation" },
    reservations: { page: "reservations", href: "reservations.html", icon: "clipboard", label: "Reservations" },
    overview: { page: "overview", href: "overview.html", icon: "dashboard", label: "Overview" },
    inventory: { page: "inventory", href: "inventory.html", icon: "package", label: "Inventory" },
    reports: { page: "reports", href: "reports.html", icon: "chart", label: "Sales reports" },
    menu: { page: "menu", href: "menu.html", icon: "utensils", label: "Menu" },
    users: { page: "users", href: "users.html", icon: "users", label: "Staff & roles" },
    requests: { page: "requests", href: "requests.html", icon: "file", label: "Staff requests" },
    settings: { page: "settings", href: "settings.html", icon: "settings", label: "Settings" },
    guests: { page: "guests", href: "guests.html", icon: "users", label: "Guests" },
    team: { page: "team", href: "team.html", icon: "clock", label: "Team" },
    insights: { page: "insights", href: "insights.html", icon: "trend", label: "Insights" },
    audit: { page: "audit", href: "audit.html", icon: "file", label: "Audit log" },
    security: { page: "security", href: "security.html", icon: "shield", label: "Security" }
  };
  const badge = function (item) { return Object.assign({}, item, { badge: true }); };
  // Grouped by kind of work: Sell · Kitchen · Manage · Reports · Settings
  const NAV = {
    Waiter: [
      { section: "Sell", items: [L.dashboard, L.order, L.tables, L.ready] },
      { section: "Guests", items: [L.reservations, L.reservation] },
      { section: "Team", items: [L.team, L.requests] }
    ],
    Barista: [
      { section: "Bar", items: [L.bar] },
      { section: "Team", items: [L.team, L.requests] }
    ],
    Kitchen: [
      { section: "Kitchen", items: [L.kitchen] },
      { section: "Team", items: [L.team, L.requests] }
    ],
    Cashier: [
      { section: "Sell", items: [badge(L.billing), L.order] },
      { section: "Team", items: [L.team, L.requests] }
    ],
    Manager: [
      { section: "Today", items: [L.overview] },
      { section: "Sell", items: [L.billing, L.reservations, L.reservation] },
      { section: "Manage", items: [badge(L.inventory), L.guests, L.team, L.requests] },
      { section: "Reports", items: [L.insights, L.reports] }
    ],
    Admin: [
      { section: "Today", items: [L.overview] },
      { section: "Manage", items: [L.menu, L.guests, L.team, L.users] },
      { section: "Reports", items: [L.insights, L.reports, L.audit] },
      { section: "Settings", items: [L.settings, L.security] }
    ]
  };
  const ACCESS = {
    Waiter: "Orders, tables and bookings. Billing, stock and admin belong to other roles.",
    Barista: "Drink tickets for the bar. No prices, payments or customer details.",
    Kitchen: "Food tickets for the kitchen. No prices, payments or customer details.",
    Cashier: "Counter orders, billing and receipts. Discounts above your limit and refunds need a manager.",
    Manager: "Operations, stock, reports and refunds. Users and menu are admin-only.",
    Admin: "Full administration. Every critical change is written to the audit log."
  };

  const pageKey = document.body.getAttribute("data-page");
  const session = Session.get();
  const hide = function () { document.documentElement.classList.add("app-loading"); };

  // ---------- Guard: signed in? ----------
  if (!session) {
    hide();
    Session.flash("Please sign in to continue.");
    window.location.replace("login.html");
    return;
  }
  Store.init();
  // ---------- Guard: role allowed on this page? (the server has already enforced this) ----------
  const page = PAGES[pageKey];
  if (!page || page.roles.indexOf(session.role) === -1) {
    hide();
    Session.flash("You don't have permission to open that page.");
    window.location.replace(HOME[session.role]);
    return;
  }

  const h = CMS.h;
  const I = function (n, s) { return Icons.node(n, s || 18); };
  const initialsOf = function (name) { return name.split(" ").map(function (p) { return p[0]; }).join("").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase(); };
  const initials = initialsOf(session.name);

  function signOut(msg) {
    const finish = function () {
      Session.wipe();
      if (msg) Session.flash(msg);
      window.location.replace("login.html");
    };
    Api.call("POST", "/auth/logout").then(finish, finish);
  }

  // ======================================================== build shell
  const main = document.getElementById("main");
  document.title = page.title + " · CafeMS";

  const groups = NAV[session.role];
  const navItems = groups.reduce(function (all, g) { return all.concat(g.items); }, []);
  const navLink = function (n) {
    const a = h("a", { href: n.href, "aria-current": n.page === pageKey ? "page" : null }, [I(n.icon), h("span", { text: n.label })]);
    if (n.badge) a.appendChild(h("span", { class: "count", "data-nav-badge": true }));
    return h("li", null, [a]);
  };

  const sidebar = h("aside", { class: "sidebar", id: "sidebar", "aria-label": "Staff navigation" }, [
    h("a", { href: HOME[session.role], class: "brand" }, [h("span", { class: "brand-mark" }, [I("coffee", 18)]), h("span", null, [h("span", { "data-cafe-name": true, text: "CafeMS" }), h("small", { text: session.role + " workspace" })])]),
    h("nav", { class: "side-groups" }, groups.map(function (g) {
      return h("div", { class: "side-group" }, [h("div", { class: "nav-section", text: g.section }), h("ul", { class: "side-nav" }, g.items.map(navLink))]);
    }).concat([
      h("div", { class: "side-group" }, [h("div", { class: "nav-section", text: "Account" }), h("ul", { class: "side-nav" }, [
        h("li", null, [h("a", { href: "account.html", "aria-current": pageKey === "account" ? "page" : null }, [I("key"), h("span", { text: "My account" })])]),
        h("li", null, [h("a", { href: "index.html" }, [I("home"), h("span", { text: "Public site" })])]),
        h("li", null, [h("button", { type: "button", "data-signout": true }, [I("logout"), h("span", { text: "Sign out" })])])
      ])])
    ])),
    h("div", { class: "sidebar-foot" }, [h("b", null, [I("shield", 15), session.role + " access"]), ACCESS[session.role]])
  ]);

  const notifBtn = h("button", { class: "icon-btn", id: "notifBtn", "aria-label": "Notifications", "aria-haspopup": "true", "aria-expanded": "false" }, [I("bell"), h("span", { class: "dot", id: "notifDot" })]);
  const notifMenu = h("div", { class: "dropdown notif-panel", id: "notifMenu" }, [
    h("div", { class: "head" }, [h("b", { text: "Notifications" }), h("span", { class: "muted", id: "notifSub" })]),
    h("div", { id: "notifList" })
  ]);
  const userBtn = h("button", { class: "user-btn", id: "userBtn", "aria-haspopup": "true", "aria-expanded": "false", "aria-label": "Account menu" }, [
    h("span", { class: "avatar", text: initials }),
    h("span", { class: "who" }, [h("b", { text: session.name }), h("small", { text: session.role })])
  ]);
  const userMenu = h("div", { class: "dropdown", id: "userMenu" }, [
    h("div", { class: "head" }, [h("b", { text: session.name }), h("span", { class: "muted", text: "@" + session.user + " · " }), h("span", { class: "pill pill-role", text: session.role })]),
    h("a", { href: HOME[session.role] }, [I("home", 16), "My workspace"]),
    h("button", { type: "button", id: "openPalette" }, [I("search", 16), "Quick search", h("kbd", { class: "kbd", text: "Ctrl K" })]),
    h("button", { type: "button", id: "openSwitch" }, [I("users", 16), "Switch user"]),
    h("a", { href: "account.html" }, [I("key", 16), "My account"]),
    h("button", { type: "button", class: "danger", "data-signout": true }, [I("logout", 16), "Sign out"])
  ]);

  const topbar = h("header", { class: "topbar" }, [
    h("button", { class: "icon-btn menu-btn", "aria-label": "Open navigation", "aria-expanded": "false", "aria-controls": "sidebar" }, [I("menu")]),
    h("div", { class: "title" }, [h("div", { class: "crumb", text: session.role + " workspace" }), h("h1", { text: page.title })]),
    h("div", { class: "spacer" }),
    h("button", { class: "search-btn", type: "button", id: "searchBtn", "aria-label": "Quick search (Ctrl+K)" }, [I("search", 16), h("span", { text: "Search…" }), h("kbd", { class: "kbd", text: "Ctrl K" })]),
    h("div", { class: "live-chip", id: "liveChip", title: "Screens update as soon as something changes" }, [h("span", { class: "live-dot" }), h("span", { class: "live-on", text: "Live" }), h("span", { class: "live-off", text: "Reconnecting" })]),
    h("div", { class: "shift-clock" }, [I("clock", 15), h("span", { id: "shiftClock" })]),
    h("div", { class: "user-menu" }, [notifBtn, notifMenu]),
    h("div", { class: "user-menu" }, [userBtn, userMenu])
  ]);

  const footer = h("footer", { class: "app-footer" }, [
    h("span", { text: "© " + new Date().getFullYear() + " CafeMS" }),
    h("span", { text: "Every action is checked and recorded by the server" })
  ]);

  const idleModal = h("div", { class: "modal-backdrop", id: "idleModal", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "idleTitle", "data-static": true }, [
    h("div", { class: "modal" }, [
      h("div", { class: "modal-head" }, [h("div", { class: "icon-tile warn" }, [I("clock", 20)]), h("div", null, [
        h("h3", { id: "idleTitle", text: "Are you still there?" }),
        h("p", null, ["For security, you'll be signed out in ", h("b", { id: "idleCount", text: "30" }), " seconds because of inactivity."])
      ])]),
      h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-primary", id: "staySignedIn", "data-autofocus": true, text: "Stay signed in" })])
    ])
  ]);

  const paletteInput = h("input", { class: "palette-input", type: "text", placeholder: "Jump to a page or action…", "aria-label": "Search pages and actions", autocomplete: "off" });
  const paletteList = h("ul", { class: "palette-list", role: "listbox" });
  const palette = h("div", { class: "modal-backdrop palette-backdrop", id: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Quick search" }, [
    h("div", { class: "palette" }, [
      h("div", { class: "palette-search" }, [I("search"), paletteInput, h("kbd", { class: "kbd", text: "Esc" })]),
      paletteList,
      h("div", { class: "palette-foot" }, [h("span", null, [h("kbd", { class: "kbd", text: "↑↓" }), " navigate"]), h("span", null, [h("kbd", { class: "kbd", text: "Enter" }), " open"])])
    ])
  ]);

  const mainCol = h("div", { class: "main" }, [topbar]);
  const app = h("div", { class: "app" }, [sidebar, h("div", { class: "scrim" }), mainCol]);
  main.parentNode.insertBefore(app, main);
  mainCol.appendChild(main);
  mainCol.appendChild(footer);
  document.body.appendChild(idleModal);
  document.body.appendChild(palette);
  if (!document.querySelector(".skip-link")) document.body.insertBefore(h("a", { href: "#main", class: "skip-link", text: "Skip to content" }), document.body.firstChild);
  document.documentElement.classList.remove("app-loading");

  // ======================================================== behaviour
  const clockEl = document.getElementById("shiftClock");
  const since = CMS.clock(new Date(session.loginAt));
  function tickClock() { clockEl.textContent = CMS.clock(new Date()) + " · on shift since " + since; }
  tickClock(); setInterval(tickClock, 15000);

  const scrim = app.querySelector(".scrim"), menuBtn = app.querySelector(".menu-btn");
  function setSidebar(open) {
    sidebar.classList.toggle("open", open); scrim.classList.toggle("show", open);
    menuBtn.setAttribute("aria-expanded", String(open));
  }
  menuBtn.addEventListener("click", function () { setSidebar(!sidebar.classList.contains("open")); });
  scrim.addEventListener("click", function () { setSidebar(false); });
  sidebar.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { setSidebar(false); }); });

  function bindDropdown(btn, menu) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); });
      menu.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    });
  }
  bindDropdown(notifBtn, notifMenu);
  bindDropdown(userBtn, userMenu);
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".dropdown")) document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); });
  });

  document.querySelectorAll("[data-signout]").forEach(function (b) {
    b.addEventListener("click", async function () {
      const ok = await CMS.confirm({ title: "Sign out?", message: "Your work is saved. You'll need to sign in again to continue.", okText: "Sign out", icon: "logout" });
      if (ok) signOut("You have been signed out.");
    });
  });

  // ---------- Role-aware notifications ----------
  function notifications() {
    if (session.role === "Waiter") {
      return Store.orders().filter(function (o) { return o.waiter === session.user && o.status === "Ready"; })
        .map(function (o) { return { icon: "bell", text: o.id + " · " + o.label + " is ready", href: "dashboard.html#ready" }; });
    }
    if ((session.role === "Kitchen" || session.role === "Barista")) {
      return Store.tickets().filter(function (o) { return o.status === "Placed"; })
        .map(function (o) { return { icon: "clipboard", text: "New order " + o.id + " · " + o.label, href: "kitchen.html" }; });
    }
    const out = [];
    if (session.role === "Cashier" || session.role === "Manager") {
      Store.openTables().filter(function (t) { return t.billRequested; }).forEach(function (t) {
        out.push({ icon: "receipt", text: "Table " + t.no + " asked for the bill", href: "billing.html#t" + t.no });
      });
    }
    if (session.role === "Manager" || session.role === "Admin") {
      Store.lowStock().forEach(function (i) {
        out.push({ icon: "package", tone: "warn", text: i.name + (i.qty <= 0 ? " is out of stock" : " is running low (" + CMS.qty(i.qty) + " " + i.unit + ")"), href: session.role === "Manager" ? "inventory.html" : "overview.html" });
      });
    }
    if (session.role === "Admin") {
      Store.alerts().slice(0, 4).forEach(function (a) { out.push({ icon: "alert", tone: "danger", text: a.title + ": " + a.details, href: "security.html" }); });
      Store.recentAudit().filter(function (e) { return e.severity === "high" && Date.now() - e.at < 86400000; }).slice(0, 4).forEach(function (e) {
        out.push({ icon: "shield", tone: "danger", text: e.action + ": " + e.details, href: "audit.html" });
      });
    }
    return out;
  }
  function badgeCount() {
    if (session.role === "Waiter") return Store.orders().filter(function (o) { return o.status === "Ready"; }).length;
    if ((session.role === "Kitchen" || session.role === "Barista")) return Store.tickets().filter(function (o) { return o.status === "Placed" || o.status === "Preparing"; }).length;
    if (session.role === "Cashier") return Store.openTables().filter(function (t) { return t.billRequested; }).length;
    if (session.role === "Manager") return Store.lowStock().length;
    return 0;
  }
  function reservationRequests() {
    return Store.reservations().filter(function (r) { return r.status === "Requested"; })
      .map(function (r) { return { icon: "calendar", text: "Online booking " + r.id + " for " + r.date + " at " + r.time + " needs confirming", href: "reservations.html" }; });
  }
  function renderNotifs() {
    const list = document.getElementById("notifList");
    const items = reservationRequests().concat(notifications());
    document.getElementById("notifDot").textContent = items.length ? String(items.length) : "";
    document.getElementById("notifSub").textContent = items.length ? items.length + " need attention" : "You're all caught up";
    list.replaceChildren();
    if (!items.length) list.appendChild(h("div", { class: "notif-empty", text: "Nothing needs your attention right now." }));
    items.slice(0, 8).forEach(function (n) {
      list.appendChild(h("a", { class: "notif-item " + (n.tone || ""), href: n.href }, [I(n.icon, 16), h("span", { text: n.text })]));
    });
    const b = badgeCount();
    document.querySelectorAll("[data-nav-badge]").forEach(function (el) { el.textContent = b ? String(b) : ""; });
  }
  // The page's HTML was already checked by the server. This confirms the display copy still matches,
  // then runs the page once the first data has arrived.
  const readyPromise = new Promise(function (resolve) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", resolve); else resolve();
  }).then(function () {
    return Promise.all([Api.me(), Store.whenReady()]);
  }).then(function (results) {
    const me = results[0];
    if (me.username !== session.user || me.role !== session.role) {
      Session.set({ user: me.username, name: me.name, role: me.role, loginAt: me.loginAt });
      window.location.replace(HOME[me.role]);
      return new Promise(function () {});
    }
    return undefined;
  });
  readyPromise.then(function () {
    renderNotifs();
    Store.on(function (changed) {
      renderNotifs();
      changed.forEach(function (o) {
        if (session.role === "Waiter" && o.status === "Ready") CMS.toast(o.id + " · " + o.label + " is ready", "info");
        if ((session.role === "Kitchen" || session.role === "Barista") && o.status === "Placed") CMS.toast("New order " + o.id + " · " + o.label, "info");
      });
    });
  }).catch(function () { window.location.replace("login.html"); });

  // ---------- Command palette ----------
  const commands = navItems.map(function (n) { return { label: n.label, hint: "Go to", icon: n.icon, run: function () { location.href = n.href; } }; });
  if (session.role === "Waiter") commands.unshift({ label: "New order", hint: "Action", icon: "plus", run: function () { location.href = "order.html"; } });
  commands.push(
    { label: "Public website", hint: "Go to", icon: "home", run: function () { location.href = "index.html"; } },
    { label: "My account", hint: "Go to", icon: "key", run: function () { location.href = "account.html"; } },
    { label: "Switch user", hint: "Action", icon: "users", run: function () { document.getElementById("openSwitch").click(); } },
    { label: "Sign out", hint: "Action", icon: "logout", run: function () { document.querySelector("[data-signout]").click(); } }
  );
  let sel = 0, filtered = commands;
  function renderPalette() {
    const q = paletteInput.value.trim().toLowerCase();
    filtered = commands.filter(function (c) { return c.label.toLowerCase().indexOf(q) !== -1; });
    sel = Math.min(sel, Math.max(filtered.length - 1, 0));
    paletteList.replaceChildren();
    if (!filtered.length) paletteList.appendChild(h("li", { class: "palette-empty", text: "No matches" }));
    filtered.forEach(function (c, i) {
      paletteList.appendChild(h("li", { role: "option", "aria-selected": String(i === sel), class: i === sel ? "active" : "",
        onclick: function () { closePalette(); c.run(); }, onmousemove: function () { if (sel !== i) { sel = i; renderPalette(); } } },
        [I(c.icon, 17), h("span", { class: "lbl", text: c.label }), h("span", { class: "hint", text: c.hint })]));
    });
  }
  function openPalette() { paletteInput.value = ""; sel = 0; renderPalette(); CMS.openModal("palette"); paletteInput.focus(); }
  function closePalette() { CMS.closeModal("palette"); }
  paletteInput.addEventListener("input", function () { sel = 0; renderPalette(); });
  paletteInput.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(filtered.length, 1); renderPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + filtered.length) % Math.max(filtered.length, 1); renderPalette(); }
    else if (e.key === "Enter" && filtered[sel]) { e.preventDefault(); const c = filtered[sel]; closePalette(); c.run(); }
  });
  document.getElementById("searchBtn").addEventListener("click", openPalette);
  document.getElementById("openPalette").addEventListener("click", openPalette);
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
    if (e.key === "Escape") { document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); }); setSidebar(false); }
  });

  // ---------- Inactivity timeout with warning (SR-6) ----------
  const IDLE_MS = 5 * 60 * 1000, WARN_MS = 30 * 1000;
  let idleTimer, countdown, warned = false;
  const HEARTBEAT_MS = 60 * 1000;
  let lastHeartbeat = Date.now();
  // Real activity keeps the server session alive; the server still ends it after 5 idle minutes
  function heartbeat() {
    if (Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = Date.now();
    Api.call("POST", "/auth/heartbeat").catch(function (e) {
      if (e.status !== 401) return;
      Session.wipe();
      Session.flash("Your session has ended. Please sign in again.");
      window.location.replace("login.html");
    });
  }
  function resetIdle() { if (warned) return; heartbeat(); clearTimeout(idleTimer); idleTimer = setTimeout(warnIdle, IDLE_MS - WARN_MS); }
  function warnIdle() {
    warned = true;
    let left = WARN_MS / 1000;
    document.getElementById("idleCount").textContent = left;
    CMS.openModal("idleModal");
    countdown = setInterval(function () {
      left--; document.getElementById("idleCount").textContent = left;
      if (left <= 0) { clearInterval(countdown); signOut("You were signed out after 5 minutes of inactivity."); }
    }, 1000);
  }
  document.getElementById("staySignedIn").addEventListener("click", function () { clearInterval(countdown); warned = false; CMS.closeModal("idleModal"); resetIdle(); });
  ["mousemove", "keydown", "click", "touchstart", "scroll"].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });
  resetIdle();

  const flash = Session.flash();
  if (flash) setTimeout(function () { CMS.toast(flash, "err"); }, 200);

  // ---------- Switch user with a PIN (shared tablets) ----------
  // The server checks the PIN, ends this session and starts the other person's. Nothing about the
  // PIN is kept in the browser.
  const pinInput = h("input", { class: "input pin-input", type: "password", inputmode: "numeric", autocomplete: "off", maxlength: "6", "aria-label": "PIN", id: "switchPin" });
  const switchErr = h("div", { class: "alert alert-error", role: "alert" });
  const switchPeople = h("div", { class: "switch-people" });
  const switchWho = h("div", { class: "switch-who" });
  const pinDots = h("div", { class: "pin-dots", "aria-hidden": "true" });
  const pinPad = h("div", { class: "pin-pad" });
  const pinStep = h("div", { class: "pin-step", hidden: true }, [switchWho, pinDots, pinInput, pinPad]);
  const switchOk = h("button", { class: "btn btn-primary", type: "button", id: "switchOk", hidden: true, text: "Switch" });
  const switchBack = h("button", { class: "btn btn-ghost", type: "button", hidden: true, text: "Back" });
  const switchModal = h("div", { class: "modal-backdrop", id: "switchModal", role: "dialog", "aria-modal": "true", "aria-labelledby": "switchTitle" }, [
    h("div", { class: "modal" }, [
      h("div", { class: "modal-head" }, [h("div", { class: "icon-tile" }, [I("users", 20)]), h("div", null, [
        h("h3", { id: "switchTitle", text: "Switch user" }),
        h("p", { text: "Tap your name and enter your PIN. This tablet's current session ends." })
      ])]),
      h("div", { class: "modal-body" }, [switchErr, switchPeople, pinStep]),
      h("div", { class: "modal-actions" }, [switchBack, h("button", { class: "btn btn-secondary", type: "button", "data-close": "switchModal", text: "Cancel" }), switchOk])
    ])
  ]);
  document.body.appendChild(switchModal);
  let switchTarget = null;
  function drawDots() {
    pinDots.replaceChildren();
    for (let i = 0; i < 6; i++) pinDots.appendChild(h("i", { class: i < pinInput.value.length ? "on" : "" }));
    switchOk.disabled = pinInput.value.length < 4;
  }
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"].forEach(function (k) {
    const label = k === "back" ? I("delete", 20) : k === "clear" ? "Clear" : k;
    pinPad.appendChild(h("button", { type: "button", class: "pin-key" + (k.length > 1 ? " fn" : ""), "aria-label": k === "back" ? "Delete last digit" : k === "clear" ? "Clear" : k, onclick: function () {
      if (k === "back") pinInput.value = pinInput.value.slice(0, -1);
      else if (k === "clear") pinInput.value = "";
      else if (pinInput.value.length < 6) pinInput.value += k;
      drawDots();
      pinInput.focus();
    } }, [label]));
  });
  pinInput.addEventListener("input", function () { pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 6); drawDots(); });
  pinInput.addEventListener("keydown", function (e) { if (e.key === "Enter" && !switchOk.disabled) switchOk.click(); });
  function showPeople() {
    switchTarget = null;
    pinStep.hidden = true; switchOk.hidden = true; switchBack.hidden = true; switchPeople.hidden = false;
  }
  function choose(person) {
    switchTarget = person;
    switchErr.classList.remove("show");
    switchWho.replaceChildren(h("span", { class: "avatar", text: initialsOf(person.name) }), h("div", null, [h("b", { text: person.name }), h("small", { text: person.role })]));
    pinInput.value = "";
    drawDots();
    switchPeople.hidden = true; pinStep.hidden = false; switchOk.hidden = false; switchBack.hidden = false;
    pinInput.focus();
  }
  async function openSwitch() {
    document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); });
    switchErr.classList.remove("show");
    showPeople();
    switchPeople.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
    CMS.openModal("switchModal");
    const result = await CMS.attempt(function () { return Api.call("GET", "/auth/switch/people"); }, switchErr);
    switchPeople.replaceChildren();
    if (!result) return;
    if (!result.people.length) {
      switchPeople.appendChild(h("div", { class: "empty-state" }, [I("users", 28), h("b", { text: "Nobody can switch in yet" }), "Waiters, kitchen staff and cashiers can set a PIN on their My account page."]));
      return;
    }
    result.people.forEach(function (p) {
      switchPeople.appendChild(h("button", { type: "button", class: "person-tile", onclick: function () { choose(p); } }, [h("span", { class: "avatar", text: initialsOf(p.name) }), h("b", { text: p.name }), h("small", { text: p.role })]));
    });
  }
  switchBack.addEventListener("click", showPeople);
  switchOk.addEventListener("click", function () {
    if (!switchTarget) return;
    CMS.busy(switchOk, async function () {
      try {
        await Api.call("POST", "/auth/switch", { username: switchTarget.username, pin: pinInput.value });
        pinInput.value = "";
        Store.forget();
        Api.csrfToken = null;
        const me = await Api.me();
        Session.set({ user: me.username, name: me.name, role: me.role, loginAt: me.loginAt });
        window.location.replace(HOME[me.role]);
      } catch (error) {
        pinInput.value = "";
        drawDots();
        switchErr.replaceChildren(I("alert", 18), h("span", { text: error.userMessage || "That did not work. Try again." }));
        switchErr.classList.add("show");
      }
    });
  });
  document.getElementById("openSwitch").addEventListener("click", openSwitch);

  window.App = { session: session, signOut: signOut, home: HOME[session.role], I: I, ready: function (fn) { readyPromise.then(fn); } };
})();
