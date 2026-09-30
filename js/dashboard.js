// Waiter dashboard: shift KPIs, my orders (filterable), ready-to-serve queue,
// floor plan with table actions, and items that are currently unavailable.
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  let filter = "active";

  function mine() { return Store.orders().filter(function (o) { return o.waiter === me; }); }
  function pill(status) { return h("span", { class: "pill pill-" + status.toLowerCase(), text: status }); }
  function itemsSummary(o) { return o.items.map(function (i) { return i.qty + "× " + i.name; }).join(", "); }
  function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }

  document.addEventListener("DOMContentLoaded", function () {
    const hour = new Date().getHours();
    const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const first = App.session.name.split(" ")[0];
    document.getElementById("greeting").textContent = part + ", " + (first.replace(".", "").length > 1 ? first : App.session.name);

    document.querySelectorAll("#orderTabs .tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        filter = tab.getAttribute("data-filter");
        document.querySelectorAll("#orderTabs .tab").forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
        renderOrders();
      });
    });
    renderAll();
    Store.on(renderAll);
    setInterval(renderOrders, 30000);
  });

  function renderAll() { renderKpis(); renderOrders(); renderReady(); renderFloor(); renderUnavailable(); }

  function renderKpis() {
    const o = mine();
    document.getElementById("kpiActive").textContent = o.filter(function (x) { return x.status === "Placed" || x.status === "Preparing"; }).length;
    document.getElementById("kpiReady").textContent = o.filter(function (x) { return x.status === "Ready"; }).length;
    document.getElementById("kpiServed").textContent = o.filter(function (x) { return x.status === "Served" && isToday(x.createdAt); }).length;
    const my = Store.TABLES.filter(function (t) { const s = Store.tableState(t.no, me).state; return s !== "free" && s !== "other"; }).length;
    const busy = Store.TABLES.filter(function (t) { return Store.tableState(t.no, me).state !== "free"; }).length;
    document.getElementById("kpiTables").textContent = my;
    document.getElementById("kpiTablesSub").textContent = busy + " of " + Store.TABLES.length + " tables busy";
  }

  // ----- Actions -----
  function serve(o) { if (CMS.attempt(function () { return Store.setOrderStatus(o.id, "Served", me); })) CMS.toast(o.id + " served to Table " + o.table, "ok"); }
  async function cancel(o) {
    const ok = await CMS.confirm({ title: "Cancel " + o.id + "?", message: "The kitchen hasn't started this order yet. Stock will be returned and the ticket removed from the kitchen display.", okText: "Cancel order", cancelText: "Keep order", danger: true, icon: "trash" });
    if (ok && CMS.attempt(function () { return Store.setOrderStatus(o.id, "Cancelled", me); })) CMS.toast(o.id + " cancelled", "err");
  }
  function details(o) {
    const t = Store.totals(o.items);
    document.getElementById("detailTitle").textContent = o.id + " · Table " + o.table;
    const sub = document.getElementById("detailSub");
    sub.innerHTML = "";
    sub.append("Placed " + CMS.timeAgo(o.createdAt) + " at " + CMS.clock(new Date(o.createdAt)) + " · ", pill(o.status));
    const body = document.getElementById("detailBody");
    body.innerHTML = "";
    body.appendChild(summaryBox(o.items, t, o.notes));
    CMS.openModal("detailModal");
  }
  function summaryBox(items, t, notes) {
    const box = h("div", { class: "summary" });
    items.forEach(function (i) { box.appendChild(h("div", { class: "row" }, [h("span", { text: i.qty + " × " + i.name }), h("span", { text: CMS.money(i.price * i.qty) })])); });
    box.appendChild(h("div", { class: "row" }, [h("span", { class: "muted", text: "Tax (16%)" }), h("span", { class: "muted", text: CMS.money(t.tax) })]));
    box.appendChild(h("div", { class: "row total" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(t.total) })]));
    if (notes) box.appendChild(h("div", { class: "note", text: "Kitchen note: " + notes })); // textContent → XSS-safe
    return box;
  }
  function actionsFor(o) {
    const w = h("div", { class: "row-actions" });
    if (o.status === "Ready") w.appendChild(h("button", { class: "btn btn-success btn-sm", icon: "check", text: "Serve", "aria-label": "Mark " + o.id + " served", onclick: function () { serve(o); } }));
    if (o.status === "Placed" && !o.billed) {
      w.appendChild(h("a", { class: "btn btn-secondary btn-sm", href: "order.html?edit=" + encodeURIComponent(o.id), text: "Edit", "aria-label": "Edit " + o.id }));
      w.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Cancel", "aria-label": "Cancel " + o.id, onclick: function () { cancel(o); } }));
    }
    w.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "View", "aria-label": "View " + o.id, onclick: function () { details(o); } }));
    return w;
  }

  // ----- My orders -----
  function renderOrders() {
    const all = mine().filter(function (o) { return isToday(o.createdAt) || Store.ACTIVE.indexOf(o.status) !== -1; });
    const sets = {
      active: all.filter(function (o) { return Store.ACTIVE.indexOf(o.status) !== -1; }),
      Ready: all.filter(function (o) { return o.status === "Ready"; }),
      Served: all.filter(function (o) { return o.status === "Served"; }),
      all: all
    };
    Object.keys(sets).forEach(function (k) { const el = document.querySelector('[data-n="' + k + '"]'); if (el) el.textContent = sets[k].length; });
    const body = document.getElementById("ordersBody");
    body.innerHTML = "";
    const rows = sets[filter];
    if (!rows.length) {
      body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [h("div", { class: "empty-state", icon: "clipboard", iconSize: 32 }, [
        h("b", { text: filter === "active" ? "No active orders" : "Nothing here yet" }),
        h("span", { text: filter === "active" ? "Orders you send to the kitchen will appear here." : "Try another filter." })
      ])])]));
      return;
    }
    rows.forEach(function (o) {
      body.appendChild(h("tr", { class: "order-row" }, [
        h("td", null, [h("span", { class: "mono", text: o.id }), o.billed ? h("small", { class: "sub-line", text: "Paid · " + o.billNo }) : null]),
        h("td", { text: "T" + o.table }),
        h("td", { class: "hide-sm" }, [h("div", { class: "items", title: itemsSummary(o), text: itemsSummary(o) })]),
        h("td", { class: "nowrap num", text: CMS.money(Store.totals(o.items).total) }),
        h("td", { class: "time hide-sm", text: CMS.timeAgo(o.createdAt) }),
        h("td", null, [pill(o.status)]),
        h("td", { class: "actions" }, [actionsFor(o)])
      ]));
    });
  }

  // ----- Ready to serve -----
  function renderReady() {
    const ready = mine().filter(function (o) { return o.status === "Ready"; });
    document.getElementById("readyPill").textContent = ready.length;
    const list = document.getElementById("readyList");
    list.innerHTML = "";
    if (!ready.length) {
      list.appendChild(h("li", { class: "empty-li" }, [h("div", { class: "empty-state", icon: "check-circle", iconSize: 28 }, [h("b", { text: "All caught up" }), h("span", { text: "You'll get an alert when the kitchen finishes an order." })])]));
      return;
    }
    ready.forEach(function (o) {
      list.appendChild(h("li", { class: "pulse-in" }, [
        h("span", { class: "tno ok", text: "T" + o.table }),
        h("div", { class: "meta" }, [h("b", { text: o.id + " · ready " + CMS.timeAgo(o.updatedAt) }), h("small", { text: itemsSummary(o) })]),
        h("button", { class: "btn btn-success btn-sm", icon: "check", text: "Serve", "aria-label": "Mark " + o.id + " served", onclick: function () { serve(o); } })
      ]));
    });
  }

  // ----- Floor plan + table actions -----
  function renderFloor() {
    const map = document.getElementById("floorMap");
    map.innerHTML = "";
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no, me);
      const btn = h("button", { class: "tbl " + st.state, type: "button", "aria-label": "Table " + t.no + ", " + t.seats + " seats, " + st.label }, [
        h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" }), h("span", { class: "st", text: st.label })
      ]);
      if (st.state === "other") btn.disabled = true;
      else if (st.state === "free") btn.addEventListener("click", function () { location.href = "order.html?table=" + t.no; });
      else btn.addEventListener("click", function () { tableActions(t, st); });
      map.appendChild(btn);
    });
  }
  function tableActions(t, st) {
    document.getElementById("tableTitle").textContent = "Table " + t.no + " · " + t.seats + " seats";
    document.getElementById("tableSub").textContent = st.label + " · " + st.orders.length + " open order" + (st.orders.length === 1 ? "" : "s");
    const body = document.getElementById("tableBody");
    body.innerHTML = "";
    const lines = [];
    st.orders.forEach(function (o) { lines.push(h("div", { class: "row" }, [h("span", null, [h("b", { class: "mono", text: o.id }), " " + itemsSummary(o)]), pill(o.status)])); });
    const tt = Store.totals([].concat.apply([], st.orders.map(function (o) { return o.items; })));
    lines.push(h("div", { class: "row total" }, [h("span", { text: "Table total (incl. tax)" }), h("span", { text: CMS.money(tt.total) })]));
    body.appendChild(h("div", { class: "summary" }, lines));
    const actions = document.getElementById("tableActions");
    actions.innerHTML = "";
    actions.appendChild(h("button", { class: "btn btn-secondary", "data-close": "tableModal", text: "Close" }));
    if (st.state === "bill") {
      body.appendChild(h("p", { class: "field-hint", style: "margin-top:12px", text: "The cashier has been notified. The table becomes free once the bill is paid." }));
    } else {
      actions.appendChild(h("a", { class: "btn btn-secondary", href: "order.html?table=" + t.no, icon: "plus", text: "Add items" }));
      const req = h("button", { class: "btn btn-primary", icon: "receipt", text: "Request bill", "data-autofocus": true, onclick: function () {
        if (CMS.attempt(function () { Store.requestBill(t.no, me); return true; })) { CMS.closeModal("tableModal"); CMS.toast("Bill requested for Table " + t.no + ". The cashier has been notified.", "ok"); }
      } });
      if (!st.served) { req.disabled = true; req.title = "Serve every order on this table first"; }
      actions.appendChild(req);
    }
    CMS.openModal("tableModal");
  }

  function renderUnavailable() {
    const list = document.getElementById("soldList");
    list.innerHTML = "";
    const items = Store.menu().filter(function (m) { return !Store.isAvailable(m.id); });
    if (!items.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "Everything on the menu is available." })])); return; }
    items.forEach(function (m) {
      list.appendChild(h("li", null, [h("span", { class: "tno danger", icon: "x", iconSize: 18 }), h("div", { class: "meta" }, [h("b", { text: m.name }), h("small", { text: m.cat + " · " + Store.unavailableReason(m.id) })])]));
    });
  }
})();
