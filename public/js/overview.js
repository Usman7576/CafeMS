// Overview for Manager and Admin: today's KPIs, revenue by hour, live floor,
// stock alerts, recent activity (bills for managers, audit trail for admins)
// and admin-only system settings.
(function () {
  if (!window.App) return;
  const h = CMS.h, s = App.session, isAdmin = s.role === "Admin";

  document.addEventListener("DOMContentLoaded", function () {
    const hour = new Date().getHours();
    document.getElementById("greeting").textContent = (hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening") + ", " + s.name.split(" ")[0];
    document.getElementById("today").textContent = CMS.dateLong(new Date()) + " · " + (isAdmin ? "Owner / administrator view" : "Manager view");
    const actions = document.getElementById("headActions");
    if (isAdmin) {
      actions.append(h("a", { class: "btn btn-secondary", href: "audit.html", icon: "file", iconSize: 16, text: "Audit log" }), h("a", { class: "btn btn-primary", href: "menu.html", icon: "utensils", iconSize: 16, text: "Manage menu" }));
    } else {
      actions.append(h("a", { class: "btn btn-secondary", href: "billing.html", icon: "receipt", iconSize: 16, text: "Billing" }), h("a", { class: "btn btn-primary", href: "inventory.html", icon: "package", iconSize: 16, text: "Inventory" }));
    }
    render();
    Store.on(render);
  });

  function render() {
    const sales = Store.salesToday(), orders = Store.orders(), low = Store.lowStock(), open = Store.openTables();
    const active = orders.filter(function (o) { return Store.ACTIVE.indexOf(o.status) !== -1; });
    document.getElementById("kRevenue").textContent = CMS.money(sales.revenue);
    document.getElementById("kRevenueSub").textContent = "Avg bill " + CMS.money(sales.avg);
    document.getElementById("kBills").textContent = sales.bills;
    document.getElementById("kBillsSub").textContent = sales.refunds ? sales.refunds + " refunded (" + CMS.money(sales.refundAmount) + ")" : "No refunds today";
    document.getElementById("kActive").textContent = active.length;
    document.getElementById("kActiveSub").textContent = open.length + " tables open · " + open.filter(function (t) { return t.billRequested; }).length + " awaiting bill";
    document.getElementById("kStock").textContent = low.length;
    document.getElementById("kStockSub").textContent = low.filter(function (i) { return i.qty <= 0; }).length + " out of stock";

    // Revenue by hour: from first sale (or 8 am) up to now
    const nowH = new Date().getHours();
    const firstH = Math.min(8, sales.byHour.findIndex(function (v) { return v > 0; }) === -1 ? 8 : sales.byHour.findIndex(function (v) { return v > 0; }));
    const data = [];
    for (let i = firstH; i <= Math.max(nowH, firstH + 5); i++) {
      data.push({ label: (i % 12 || 12) + (i < 12 ? "a" : "p"), value: sales.byHour[i] || 0, highlight: i === nowH, title: (i % 12 || 12) + ":00 " + (i < 12 ? "AM" : "PM") + " · " + CMS.money(sales.byHour[i] || 0) });
    }
    CMS.barChart(document.getElementById("hourChart"), data, { label: "Revenue by hour today" });

    // Flow + mini floor
    const flow = document.getElementById("flow");
    flow.innerHTML = "";
    [["Placed", "placed"], ["Preparing", "preparing"], ["Ready", "ready"]].forEach(function (f) {
      const n = orders.filter(function (o) { return o.status === f[0]; }).length;
      flow.appendChild(h("div", { class: "flow-step " + f[1] }, [h("b", { text: String(n) }), h("span", { text: f[0] })]));
    });
    flow.appendChild(h("div", { class: "flow-step bill" }, [h("b", { text: String(open.filter(function (t) { return t.billRequested; }).length) }), h("span", { text: "Awaiting bill" })]));
    const mini = document.getElementById("floorMini");
    mini.innerHTML = "";
    Store.TABLES.forEach(function (t) {
      const tab = open.find(function (x) { return x.no === t.no; });
      const st = !tab ? ["free", "Free"] : tab.billRequested ? ["bill", "Bill"] : tab.orders.some(function (o) { return o.status === "Ready"; }) ? ["ready", "Ready"] : ["mine", tab.allServed ? "Dining" : "Cooking"];
      mini.appendChild(h("div", { class: "tbl " + st[0], title: "Table " + t.no + (tab ? " · " + tab.waiters.join(", ") + " · " + CMS.money(tab.totals.total) : " · free") }, [h("b", { text: "T" + t.no }), h("span", { class: "st", text: st[1] })]));
    });

    // Stock alerts
    const sl = document.getElementById("stockList");
    sl.innerHTML = "";
    if (!low.length) sl.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "All stock is above reorder levels." })]));
    low.sort(function (a, b) { return a.qty - b.qty; }).forEach(function (i) {
      sl.appendChild(h("li", null, [
        h("span", { class: "tno " + (i.qty <= 0 ? "danger" : "warn"), icon: i.qty <= 0 ? "x" : "alert", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: i.name }), h("small", { text: (i.qty <= 0 ? "Out of stock" : CMS.qty(i.qty) + " " + i.unit + " left") + " · reorder at " + i.reorder + " " + i.unit + " · " + i.supplier })]),
        !isAdmin ? h("a", { class: "btn btn-secondary btn-sm", href: "inventory.html?restock=" + i.id, text: "Restock" }) : null
      ]));
    });

    // Activity
    const act = document.getElementById("activity");
    act.innerHTML = "";
    if (isAdmin) {
      document.getElementById("activityTitle").textContent = "Recent audit events";
      const v = Store.verifyAudit();
      document.getElementById("activitySub").textContent = v.ok ? "Hash chain verified · " + v.count + " entries" : "Integrity check FAILED at entry #" + v.brokenAt;
      Store.auditLog().slice(0, 7).forEach(function (e) {
        act.appendChild(h("li", { class: "sev-" + e.severity }, [h("span", { class: "dot" }), h("div", null, [h("b", { text: e.action }), h("span", { text: e.details }), h("small", { text: e.name + " · " + CMS.timeAgo(e.at) })])]));
      });
      act.appendChild(h("li", { class: "more" }, [h("a", { href: "audit.html", text: "Open full audit log →" })]));
      renderSettings();
    } else {
      document.getElementById("activityTitle").textContent = "Latest bills";
      document.getElementById("activitySub").textContent = "Payments recorded by cashiers today";
      Store.bills(App.session.user).slice(0, 6).forEach(function (b) {
        const u = Store.findUser(b.cashier);
        act.appendChild(h("li", { class: b.status === "Refunded" ? "sev-high" : "sev-info" }, [h("span", { class: "dot" }), h("div", null, [
          h("b", { text: b.no + " · " + CMS.money(b.total) }), h("span", { text: "Table " + b.table + " · " + (b.method === "Wallet" ? "Mobile wallet" : b.method) + (b.status === "Refunded" ? " · refunded" : "") }),
          h("small", { text: (u ? u.name : b.cashier) + " · " + CMS.timeAgo(b.createdAt) })
        ])]));
      });
    }
  }

  function renderSettings() {
    const panel = document.getElementById("settingsPanel");
    panel.hidden = false;
    const body = document.getElementById("settingsBody");
    body.innerHTML = "";
    const st = Store.settings();
    const sw = h("input", { type: "checkbox", class: "switch", id: "simToggle" });
    sw.checked = !!st.kitchenSim;
    sw.addEventListener("change", function () { Store.setSetting("kitchenSim", sw.checked, s.user); CMS.toast("Kitchen simulation " + (sw.checked ? "on" : "off"), "ok"); });
    body.appendChild(h("label", { class: "setting", for: "simToggle" }, [
      h("div", null, [h("b", { text: "Kitchen auto-simulation" }), h("small", { text: "Moves new orders to Preparing (10 s) and Ready (20 s) while no one has the kitchen display open. It pauses automatically when a kitchen user is working." })]),
      sw
    ]));
  }
})();
