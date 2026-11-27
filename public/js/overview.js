// Overview for Manager and Admin: today's KPIs, revenue by hour, live floor,
// stock alerts, recent activity (bills for managers, audit trail for admins)
// and admin-only system settings.
(function () {
  if (!window.App) return;
  const h = CMS.h, s = App.session, isAdmin = s.role === "Admin";

  // Today against last week, best sellers and who is on shift; refreshed when sales or the clock change
  async function renderGlance() {
    const [t, on] = await Promise.all([Api.call("GET", "/insights/today").catch(function () { return null; }), Api.call("GET", "/timeclock/now").catch(function () { return null; })]);
    const body = document.getElementById("glanceBody");
    if (!t) return;
    const delta = function (n) { return n === null ? h("small", { class: "muted", text: "No sales last week to compare" }) : h("small", { class: n >= 0 ? "up" : "down", text: (n >= 0 ? "▲ " : "▼ ") + Math.abs(n) + "% on last week" }); };
    body.replaceChildren(
      h("div", { class: "glance-item" }, [h("small", { text: "Revenue" }), h("b", { text: CMS.money(t.revenue) }), delta(t.change)]),
      h("div", { class: "glance-item" }, [h("small", { text: "Visits" }), h("b", { text: String(t.checks) }), delta(t.checksChange)]),
      h("div", { class: "glance-item" }, [h("small", { text: "Average visit" }), h("b", { text: CMS.money(t.avgTicket) }), h("small", { class: "muted", text: "Tips " + CMS.money(t.tips) })]),
      h("div", { class: "glance-item" }, [h("small", { text: "Best sellers" }), h("span", { text: t.top.length ? t.top.slice(0, 3).map(function (i) { return i.qty + "× " + i.name; }).join(", ") : "Nothing sold yet" })]),
      h("div", { class: "glance-item" }, [h("small", { text: "On shift now" }), h("span", { text: on && on.people.length ? on.people.map(function (p) { return p.name.split(" ")[0]; }).join(", ") : "Nobody clocked in" })])
    );
  }

  App.ready(function () {
    renderGlance();
    Store.on(renderGlance);
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
    const sales = Store.salesToday(), low = Store.lowStock(), open = Store.openTables();
    const orders = [].concat.apply([], open.map(function (t) { return t.orders; }));
    const active = orders.filter(function (o) { return Store.ACTIVE.indexOf(o.status) !== -1; });
    CMS.renderApprovals(document.getElementById("approvalList"));
    document.getElementById("kRevenue").textContent = CMS.money(sales.revenue);
    document.getElementById("kRevenueSub").textContent = "Avg bill " + CMS.money(sales.avg);
    document.getElementById("kBills").textContent = sales.bills;
    document.getElementById("kBillsSub").textContent = sales.refunds ? sales.refunds + " refunded (" + CMS.money(sales.refundAmount) + ")" : "No refunds today";
    document.getElementById("kActive").textContent = active.length;
    document.getElementById("kActiveSub").textContent = open.filter(function (t) { return t.type === "dine-in"; }).length + " tables open · " + open.filter(function (t) { return t.type !== "dine-in"; }).length + " counter orders · " + open.filter(function (t) { return t.billRequested; }).length + " awaiting bill";
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
    flow.replaceChildren();
    [["Placed", "placed"], ["Preparing", "preparing"], ["Ready", "ready"]].forEach(function (f) {
      const n = orders.filter(function (o) { return o.status === f[0]; }).length;
      flow.appendChild(h("div", { class: "flow-step " + f[1] }, [h("b", { text: String(n) }), h("span", { text: f[0] })]));
    });
    flow.appendChild(h("div", { class: "flow-step bill" }, [h("b", { text: String(open.filter(function (t) { return t.billRequested; }).length) }), h("span", { text: "Awaiting bill" })]));
    const mini = document.getElementById("floorMini");
    mini.replaceChildren();
    Store.TABLES.forEach(function (t) {
      const tab = open.find(function (x) { return x.no === t.no; });
      const st = !tab ? ["free", "Free"] : tab.billRequested ? ["bill", "Bill"] : tab.orders.some(function (o) { return o.status === "Ready"; }) ? ["ready", "Ready"] : ["mine", tab.allServed ? "Dining" : "Cooking"];
      mini.appendChild(h("div", { class: "tbl " + st[0], title: "Table " + t.no + (tab ? " · " + tab.waiters.join(", ") + " · " + CMS.money(tab.totals.total) : " · free") }, [h("b", { text: "T" + t.no }), h("span", { class: "st", text: st[1] })]));
    });

    // Stock alerts
    const sl = document.getElementById("stockList");
    sl.replaceChildren();
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
    act.replaceChildren();
    if (isAdmin) {
      document.getElementById("activityTitle").textContent = "Recent audit events";
      document.getElementById("activitySub").textContent = "Recorded by the server";
      Store.recentAudit().slice(0, 7).forEach(function (e) {
        act.appendChild(h("li", { class: "sev-" + e.severity }, [h("span", { class: "dot" }), h("div", null, [h("b", { text: e.action }), h("span", { text: e.details }), h("small", { text: e.actor + " · " + CMS.timeAgo(e.at) })])]));
      });
      act.appendChild(h("li", { class: "more" }, [h("a", { href: "audit.html", text: "Open full audit log →" })]));
    } else {
      document.getElementById("activityTitle").textContent = "Latest bills";
      document.getElementById("activitySub").textContent = "Payments recorded by cashiers today";
      Store.bills().slice(0, 6).forEach(function (b) {
        act.appendChild(h("li", { class: b.status === "Refunded" ? "sev-high" : "sev-info" }, [h("span", { class: "dot" }), h("div", null, [
          h("b", { text: b.no + " · " + CMS.money(b.total) }), h("span", { text: "Table " + b.table + " · " + (b.method === "Wallet" ? "Mobile wallet" : b.method) + (b.status === "Refunded" ? " · refunded" : "") }),
          h("small", { text: Store.staffName(b.cashier) + " · " + CMS.timeAgo(b.createdAt) })
        ])]));
      });
    }
  }

})();
