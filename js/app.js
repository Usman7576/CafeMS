// Staff app shell: session guard, role-based navigation (RBAC — UX layer only),
// sidebar, top bar, notifications, command palette (Ctrl/⌘+K), user menu and
// inactivity timeout. Each staff page only contains its <main> content.
(function () {
  const PAGES = {
    dashboard: { title: "Dashboard",       roles: ["Waiter"] },
    order:     { title: "Take order",      roles: ["Waiter"] },
    reservation: { title: "New reservation", roles: ["Waiter", "Manager"] },
    reservations: { title: "Reservation queue", roles: ["Waiter", "Manager"] },
    kitchen:   { title: "Kitchen display", roles: ["Kitchen"] },
    billing:   { title: "Billing",         roles: ["Cashier", "Manager"] },
    overview:  { title: "Overview",        roles: ["Manager", "Admin"] },
    inventory: { title: "Inventory",       roles: ["Manager"] },
    reports:   { title: "Sales reports",   roles: ["Manager", "Admin"] },
    menu:      { title: "Menu management", roles: ["Admin"] },
    users:     { title: "Staff & roles",   roles: ["Admin"] },
    audit:     { title: "Audit log",       roles: ["Admin"] }
  };
  const HOME = { Waiter: "dashboard.html", Kitchen: "kitchen.html", Cashier: "billing.html", Manager: "overview.html", Admin: "overview.html" };
  const NAV = {
    Waiter: [
      { page: "dashboard", href: "dashboard.html", icon: "dashboard", label: "Dashboard" },
      { page: "order", href: "order.html", icon: "clipboard", label: "Take order" },
      { page: "reservation", href: "reservation.html", icon: "calendar", label: "New reservation" },
      { page: "reservations", href: "reservations.html", icon: "clipboard", label: "Reservation queue" },
      { href: "dashboard.html#ready", icon: "bell", label: "Ready to serve", badge: true },
      { href: "dashboard.html#floor", icon: "grid", label: "Tables" }
    ],
    Kitchen: [{ page: "kitchen", href: "kitchen.html", icon: "chef", label: "Kitchen display", badge: true }],
    Cashier: [{ page: "billing", href: "billing.html", icon: "receipt", label: "Billing", badge: true }],
    Manager: [
      { page: "overview", href: "overview.html", icon: "dashboard", label: "Overview" },
      { page: "billing", href: "billing.html", icon: "receipt", label: "Billing" },
      { page: "inventory", href: "inventory.html", icon: "package", label: "Inventory", badge: true },
      { page: "reports", href: "reports.html", icon: "chart", label: "Sales reports" },
      { page: "reservation", href: "reservation.html", icon: "calendar", label: "New reservation" },
      { page: "reservations", href: "reservations.html", icon: "clipboard", label: "Reservation queue" }
    ],
    Admin: [
      { page: "overview", href: "overview.html", icon: "dashboard", label: "Overview" },
      { page: "menu", href: "menu.html", icon: "utensils", label: "Menu" },
      { page: "users", href: "users.html", icon: "users", label: "Staff & roles" },
      { page: "reports", href: "reports.html", icon: "chart", label: "Sales reports" },
      { page: "audit", href: "audit.html", icon: "file", label: "Audit log" }
    ]
  };
  const ACCESS = {
    Waiter: "Waiter tools only. Billing, inventory, reports and admin belong to other roles.",
    Kitchen: "Order queue only. No prices, payments or customer details.",
    Cashier: "Billing and receipts. Discounts above 10% and refunds need a manager.",
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
  const me = Store.findUser(session.user);
  if (!me || me.status !== "Active" || me.role !== session.role) {
    // Account disabled or role changed by an admin since sign-in → force re-authentication
    hide();
    Session.clear();
    Session.flash("Your session has ended. Please sign in again.");
    window.location.replace("login.html");
    return;
  }
  // ---------- Guard: role allowed on this page? ----------
  const page = PAGES[pageKey];
  if (!page || page.roles.indexOf(session.role) === -1) {
    hide();
    Store.log(session.user, "Access denied", "Tried to open " + pageKey + ".html", "warning");
    Session.flash("You don't have permission to open that page.");
    window.location.replace(HOME[session.role]);
    return;
  }

  const h = CMS.h;
  const I = function (n, s) { const span = document.createElement("span"); span.innerHTML = Icons.svg(n, s || 18); return span.firstChild; };
  const initials = session.name.split(" ").map(function (p) { return p[0]; }).join("").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase();

  function signOut(msg, reason) {
    Store.log(session.user, "Signed out", reason || "User signed out", "info");
    Session.clear();
    if (msg) Session.flash(msg);
    window.location.replace("login.html");
  }

  // ======================================================== build shell
  const main = document.getElementById("main");
  document.title = page.title + " — Cafe Management System";

  const navItems = NAV[session.role];
  const sideNav = h("ul", { class: "side-nav" }, navItems.map(function (n) {
    const a = h("a", { href: n.href, "aria-current": n.page === pageKey ? "page" : null }, [I(n.icon), n.label]);
    if (n.badge) a.appendChild(h("span", { class: "count", "data-nav-badge": true }));
    return h("li", null, [a]);
  }));

  const sidebar = h("aside", { class: "sidebar", id: "sidebar", "aria-label": "Staff navigation" }, [
    h("a", { href: HOME[session.role], class: "brand light" }, [h("span", { class: "brand-mark" }, [I("coffee", 19)]), h("span", null, ["CafeMS", h("small", { text: session.role + " workspace" })])]),
    h("div", { class: "nav-section", text: session.role === "Admin" ? "Administration" : session.role }),
    sideNav,
    h("div", { class: "nav-section", text: "Account" }),
    h("ul", { class: "side-nav" }, [
      h("li", null, [h("a", { href: "index.html" }, [I("home"), "Public site"])]),
      h("li", null, [h("button", { type: "button", "data-signout": true }, [I("logout"), "Sign out"])])
    ]),
    h("div", { class: "sidebar-foot" }, [h("b", null, [I("shield", 16), session.role + " access"]), ACCESS[session.role]])
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
    h("button", { type: "button", id: "resetDemo" }, [I("refresh", 16), "Reset demo data"]),
    h("button", { type: "button", class: "danger", "data-signout": true }, [I("logout", 16), "Sign out"])
  ]);

  const topbar = h("header", { class: "topbar" }, [
    h("button", { class: "icon-btn menu-btn", "aria-label": "Open navigation", "aria-expanded": "false", "aria-controls": "sidebar" }, [I("menu")]),
    h("div", { class: "title" }, [h("div", { class: "crumb", text: session.role + " workspace" }), h("h1", { text: page.title })]),
    h("div", { class: "spacer" }),
    h("button", { class: "search-btn", type: "button", id: "searchBtn", "aria-label": "Quick search (Ctrl+K)" }, [I("search", 16), h("span", { text: "Search…" }), h("kbd", { class: "kbd", text: "Ctrl K" })]),
    h("div", { class: "shift-clock" }, [I("clock", 15), h("span", { id: "shiftClock" })]),
    h("div", { class: "user-menu" }, [notifBtn, notifMenu]),
    h("div", { class: "user-menu" }, [userBtn, userMenu])
  ]);

  const footer = h("footer", { class: "app-footer" }, [
    h("span", { text: "© " + new Date().getFullYear() + " Cafe Management System · SSD semester project" }),
    h("span", { text: "Prototype v2.0 · demo data stored in this browser" })
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
  document.getElementById("resetDemo").addEventListener("click", async function () {
    const ok = await CMS.confirm({ title: "Reset demo data?", message: "All orders, bills, stock, menu, staff and audit entries go back to the starting demo data. This affects every role on this device.", okText: "Reset data", danger: true, icon: "refresh" });
    if (ok) { Store.reset(session.user); CMS.toast("Demo data has been reset", "ok"); setTimeout(function () { location.reload(); }, 600); }
  });

  // ---------- Role-aware notifications ----------
  function notifications() {
    const orders = Store.orders();
    if (session.role === "Waiter") {
      return orders.filter(function (o) { return o.waiter === session.user && o.status === "Ready"; })
        .map(function (o) { return { icon: "bell", text: o.id + " for Table " + o.table + " is ready to serve", href: "dashboard.html#ready" }; });
    }
    if (session.role === "Kitchen") {
      return orders.filter(function (o) { return o.status === "Placed"; })
        .map(function (o) { return { icon: "clipboard", text: "New order " + o.id + " · Table " + o.table, href: "kitchen.html" }; });
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
      Store.auditLog().filter(function (e) { return e.severity === "high" && Date.now() - e.at < 86400000; }).slice(0, 4).forEach(function (e) {
        out.push({ icon: "shield", tone: "danger", text: e.action + ": " + e.details, href: "audit.html" });
      });
    }
    return out;
  }
  function badgeCount() {
    const orders = Store.orders();
    if (session.role === "Waiter") return orders.filter(function (o) { return o.waiter === session.user && o.status === "Ready"; }).length;
    if (session.role === "Kitchen") return orders.filter(function (o) { return o.status === "Placed" || o.status === "Preparing"; }).length;
    if (session.role === "Cashier") return Store.openTables().filter(function (t) { return t.billRequested; }).length;
    if (session.role === "Manager") return Store.lowStock().length;
    return 0;
  }
  function renderNotifs() {
    const list = document.getElementById("notifList");
    const items = notifications();
    document.getElementById("notifDot").textContent = items.length ? String(items.length) : "";
    document.getElementById("notifSub").textContent = items.length ? items.length + " need attention" : "You're all caught up";
    list.innerHTML = "";
    if (!items.length) list.appendChild(h("div", { class: "notif-empty", text: "Nothing needs your attention right now." }));
    items.slice(0, 8).forEach(function (n) {
      list.appendChild(h("a", { class: "notif-item " + (n.tone || ""), href: n.href }, [I(n.icon, 16), h("span", { text: n.text })]));
    });
    const b = badgeCount();
    document.querySelectorAll("[data-nav-badge]").forEach(function (el) { el.textContent = b ? String(b) : ""; });
  }
  renderNotifs();
  Store.on(function (changed) {
    renderNotifs();
    changed.forEach(function (o) {
      if (session.role === "Waiter" && o.waiter === session.user && o.status === "Ready") CMS.toast(o.id + " for Table " + o.table + " is ready to serve", "info");
      if (session.role === "Kitchen" && o.status === "Placed") CMS.toast("New order " + o.id + " for Table " + o.table, "info");
    });
  });

  // ---------- Command palette ----------
  const commands = navItems.map(function (n) { return { label: n.label, hint: "Go to", icon: n.icon, run: function () { location.href = n.href; } }; });
  if (session.role === "Waiter") commands.unshift({ label: "New order", hint: "Action", icon: "plus", run: function () { location.href = "order.html"; } });
  commands.push(
    { label: "Public website", hint: "Go to", icon: "home", run: function () { location.href = "index.html"; } },
    { label: "Reset demo data", hint: "Action", icon: "refresh", run: function () { document.getElementById("resetDemo").click(); } },
    { label: "Sign out", hint: "Action", icon: "logout", run: function () { document.querySelector("[data-signout]").click(); } }
  );
  let sel = 0, filtered = commands;
  function renderPalette() {
    const q = paletteInput.value.trim().toLowerCase();
    filtered = commands.filter(function (c) { return c.label.toLowerCase().indexOf(q) !== -1; });
    sel = Math.min(sel, Math.max(filtered.length - 1, 0));
    paletteList.innerHTML = "";
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
  function resetIdle() { if (warned) return; clearTimeout(idleTimer); idleTimer = setTimeout(warnIdle, IDLE_MS - WARN_MS); }
  function warnIdle() {
    warned = true;
    let left = WARN_MS / 1000;
    document.getElementById("idleCount").textContent = left;
    CMS.openModal("idleModal");
    countdown = setInterval(function () {
      left--; document.getElementById("idleCount").textContent = left;
      if (left <= 0) { clearInterval(countdown); signOut("You were signed out after 5 minutes of inactivity.", "Automatic sign-out after inactivity"); }
    }, 1000);
  }
  document.getElementById("staySignedIn").addEventListener("click", function () { clearInterval(countdown); warned = false; CMS.closeModal("idleModal"); resetIdle(); });
  ["mousemove", "keydown", "click", "touchstart", "scroll"].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true }); });
  resetIdle();

  const flash = Session.flash();
  if (flash) setTimeout(function () { CMS.toast(flash, "err"); }, 200);

  window.App = { session: session, signOut: signOut, home: HOME[session.role], I: I };
})();
