// Waiter dashboard: shift KPIs, my orders (filterable), ready-to-serve queue,
// table status map and unavailable items.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  let filter = "active";

  document.addEventListener("DOMContentLoaded", function () {
    const hour = new Date().getHours();
    const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    document.getElementById("greeting").textContent = part + ", " + App.session.name.split(" ")[0];

    // ----- Interaction: filter tabs -----
    document.querySelectorAll("#orderTabs .tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        filter = tab.getAttribute("data-filter");
        document.querySelectorAll("#orderTabs .tab").forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
        renderOrders();
      });
    });

    renderAll();
    Store.on(renderAll);
    setInterval(renderOrders, 30000); // keep "x min ago" fresh
  });

  function renderAll() { renderKpis(); renderOrders(); renderReady(); renderFloor(); renderSoldOut(); }

  function renderKpis() {
    const s = Store.stats();
    document.getElementById("kpiActive").textContent = s.active;
    document.getElementById("kpiReady").textContent = s.ready;
    document.getElementById("kpiServed").textContent = s.served;
    document.getElementById("kpiTables").textContent = s.tablesBusy + "/" + s.tablesTotal;
  }

  function pill(status) { return h("span", { class: "pill pill-" + status.toLowerCase(), text: status }); }
  function itemsSummary(o) { return o.items.map(function (i) { return i.qty + "× " + i.name; }).join(", "); }

  // ----- Actions -----
  async function markServed(o) {
    Store.setStatus(o.id, "Served");
    CMS.toast(o.id + " served to Table " + o.table, "ok");
  }
  async function cancelOrder(o) {
    const ok = await CMS.confirm({
      title: "Cancel " + o.id + "?",
      message: "The kitchen hasn't started this order yet. Cancelling removes it from the kitchen queue for Table " + o.table + ".",
      okText: "Cancel order", cancelText: "Keep order", danger: true, icon: "trash"
    });
    if (!ok) return;
    if (Store.get(o.id).status !== "Placed") { CMS.toast("Too late: the kitchen has already started " + o.id, "err"); return; }
    Store.setStatus(o.id, "Cancelled");
    CMS.toast(o.id + " cancelled", "err");
  }
  function showDetails(o) {
    const t = Store.totals(o.items);
    document.getElementById("detailTitle").textContent = o.id + " · Table " + o.table;
    const sub = document.getElementById("detailSub");
    sub.innerHTML = "";
    sub.append("Placed " + CMS.timeAgo(o.createdAt) + " at " + CMS.clock(new Date(o.createdAt)) + " · ", pill(o.status));
    const body = document.getElementById("detailBody");
    body.innerHTML = "";
    const box = h("div", { class: "summary" });
    o.items.forEach(function (i) {
      box.appendChild(h("div", { class: "row" }, [h("span", { text: i.qty + " × " + i.name }), h("span", { text: CMS.money(i.price * i.qty) })]));
    });
    box.appendChild(h("div", { class: "row" }, [h("span", { class: "muted", text: "Tax (" + Math.round(Store.TAX_RATE * 100) + "%)" }), h("span", { class: "muted", text: CMS.money(t.tax) })]));
    box.appendChild(h("div", { class: "row total" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(t.total) })]));
    if (o.notes) box.appendChild(h("div", { class: "note", text: "Kitchen note: " + o.notes })); // textContent → XSS-safe
    body.appendChild(box);
    CMS.openModal("detailModal");
  }

  function actionsFor(o) {
    const wrap = h("div", { style: "display:inline-flex;gap:6px;" });
    if (o.status === "Ready") wrap.appendChild(h("button", { class: "btn btn-success btn-sm", icon: "check", text: "Serve", "aria-label": "Mark " + o.id + " served", onclick: function () { markServed(o); } }));
    if (o.status === "Placed") wrap.appendChild(h("button", { class: "btn btn-secondary btn-sm", text: "Cancel", "aria-label": "Cancel " + o.id, onclick: function () { cancelOrder(o); } }));
    wrap.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "View", "aria-label": "View " + o.id, onclick: function () { showDetails(o); } }));
    return wrap;
  }

  // ----- My orders table -----
  function renderOrders() {
    const all = Store.all();
    const sets = {
      active: all.filter(function (o) { return Store.ACTIVE.indexOf(o.status) !== -1; }),
      Ready: all.filter(function (o) { return o.status === "Ready"; }),
      Served: all.filter(function (o) { return o.status === "Served"; }),
      all: all
    };
    Object.keys(sets).forEach(function (k) {
      const el = document.querySelector('[data-n="' + k + '"]');
      if (el) el.textContent = sets[k].length;
    });

    const body = document.getElementById("ordersBody");
    body.innerHTML = "";
    const rows = sets[filter];
    if (!rows.length) {
      body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [
        h("div", { class: "empty-state", icon: "clipboard", iconSize: 32 }, [
          h("b", { text: filter === "active" ? "No active orders" : "Nothing here yet" }),
          h("span", { text: filter === "active" ? "Orders you send to the kitchen will appear here." : "Try another filter." })
        ])
      ])]));
      return;
    }
    rows.forEach(function (o) {
      body.appendChild(h("tr", { class: "order-row" }, [
        h("td", { text: o.id }),
        h("td", { text: "T" + o.table }),
        h("td", { class: "hide-sm" }, [h("div", { class: "items", title: itemsSummary(o), text: itemsSummary(o) })]),
        h("td", { class: "nowrap", text: CMS.money(o.total) }),
        h("td", { class: "time hide-sm", text: CMS.timeAgo(o.createdAt) }),
        h("td", null, [pill(o.status)]),
        h("td", { class: "actions" }, [actionsFor(o)])
      ]));
    });
  }

  // ----- Ready to serve -----
  function renderReady() {
    const ready = Store.byStatus("Ready");
    document.getElementById("readyPill").textContent = ready.length;
    const list = document.getElementById("readyList");
    list.innerHTML = "";
    if (!ready.length) {
      list.appendChild(h("li", null, [h("div", { class: "empty-state", style: "padding:20px 0;", icon: "check-circle", iconSize: 28 }, [
        h("b", { text: "All caught up" }), h("span", { text: "You'll be alerted when the kitchen finishes an order." })
      ])]));
      return;
    }
    ready.forEach(function (o) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno", text: "T" + o.table }),
        h("div", { class: "meta" }, [h("b", { text: o.id }), h("small", { text: itemsSummary(o) })]),
        h("button", { class: "btn btn-success btn-sm", icon: "check", text: "Serve", "aria-label": "Mark " + o.id + " served", onclick: function () { markServed(o); } })
      ]));
    });
  }

  // ----- Table status map -----
  function renderFloor() {
    const map = document.getElementById("floorMap");
    map.innerHTML = "";
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no);
      const btn = h("button", { class: "tbl " + st.state, type: "button" }, [
        h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" }), h("span", { class: "st", text: st.label })
      ]);
      if (st.state === "other") {
        btn.disabled = true;
        btn.setAttribute("aria-label", "Table " + t.no + ", served by other staff");
      } else if (st.state === "ready") {
        btn.setAttribute("aria-label", "Table " + t.no + ", order ready to serve");
        btn.addEventListener("click", function () { document.getElementById("ready").scrollIntoView({ behavior: "smooth", block: "start" }); });
      } else if (st.served) {
        btn.setAttribute("aria-label", "Table " + t.no + ", all orders served");
        btn.addEventListener("click", async function () {
          const ok = await CMS.confirm({ title: "Table " + t.no + ": guests have left?", message: "Mark the table as free so it can be seated again. The bill is handled by the cashier.", okText: "Mark as free", icon: "grid" });
          if (ok) { Store.clearTable(t.no); CMS.toast("Table " + t.no + " is now free", "ok"); }
        });
      } else {
        btn.setAttribute("aria-label", "Table " + t.no + ", " + st.label + ". Take order");
        btn.addEventListener("click", function () { window.location.href = "order.html?table=" + t.no; });
      }
      map.appendChild(btn);
    });
  }

  function renderSoldOut() {
    const list = document.getElementById("soldList");
    list.innerHTML = "";
    Store.MENU.filter(function (m) { return !m.available; }).forEach(function (m) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno", style: "background:var(--danger-50);color:var(--danger);", icon: "x", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: m.name }), h("small", { text: m.cat + " · sold out" })])
      ]));
    });
  }
})();
