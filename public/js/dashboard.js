// Waiter dashboard: shift KPIs, my orders (filterable), ready-to-serve queue,
// floor plan with table actions, and items that are currently unavailable.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  let filter = "active";

  function mine() { return Store.orders(); }
  function pill(status) { return h("span", { class: "pill pill-" + status.toLowerCase(), text: status }); }
  function itemsSummary(o) { return o.items.map(function (i) { return i.qty + "× " + i.name + (i.options && i.options.length ? " (" + i.options.join(", ") + ")" : ""); }).join(", "); }
  const where = function (o) { return o.type && o.type !== "dine-in" ? o.label : "T" + o.table; };
  // Nothing has been started yet, so the order can still be changed or cancelled
  const notStarted = function (o) { return o.status === "Held" || (o.status === "Placed" && Object.keys(o.stations || {}).every(function (s) { return o.stations[s] === "Placed"; })); };
  function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }

  App.ready(function () {
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
    const my = Store.TABLES.filter(function (t) { const s = Store.tableState(t.no).state; return s !== "free" && s !== "other"; }).length;
    const busy = Store.TABLES.filter(function (t) { return Store.tableState(t.no).state !== "free"; }).length;
    document.getElementById("kpiTables").textContent = my;
    document.getElementById("kpiTablesSub").textContent = busy + " of " + Store.TABLES.length + " tables busy";
  }

  // ----- Actions -----
  async function serve(o) { if (await CMS.attempt(function () { return Store.serve(o.id); })) CMS.toast(o.id + " · " + o.label + (o.type === "dine-in" ? " served" : " handed over"), "ok"); }
  async function sendHeld(o) { if (await CMS.attempt(function () { return Store.send(o.id); })) CMS.toast(o.id + " sent to the kitchen", "ok"); }
  async function cancel(o) {
    const ok = await CMS.confirm({ title: "Cancel " + o.id + "?", message: "The kitchen hasn't started this order yet. Stock will be returned and the ticket removed from the kitchen display.", okText: "Cancel order", cancelText: "Keep order", danger: true, icon: "trash" });
    if (ok && await CMS.attempt(function () { return Store.cancel(o.id); })) CMS.toast(o.id + " cancelled", "err");
  }
  function details(o) {
    const t = Store.totals(o.items);
    document.getElementById("detailTitle").textContent = o.id + " · " + o.label;
    const sub = document.getElementById("detailSub");
    sub.replaceChildren();
    sub.append("Placed " + CMS.timeAgo(o.createdAt) + " at " + CMS.clock(new Date(o.createdAt)) + " · ", pill(o.status));
    const body = document.getElementById("detailBody");
    body.replaceChildren();
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
    if (o.status === "Held") w.appendChild(h("button", { class: "btn btn-primary btn-sm", icon: "send", text: "Send", "aria-label": "Send " + o.id + " to the kitchen", onclick: function () { sendHeld(o); } }));
    if (notStarted(o) && !o.billed) {
      w.appendChild(h("a", { class: "btn btn-secondary btn-sm", href: "order.html?edit=" + encodeURIComponent(o.id), text: "Edit", "aria-label": "Edit " + o.id }));
      w.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Cancel", "aria-label": "Cancel " + o.id, onclick: function () { cancel(o); } }));
    }
    if (o.type === "dine-in" && !o.billed && o.status !== "Cancelled") w.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Move", "aria-label": "Move " + o.id + " to another table", onclick: function () { moveOrder(o); } }));
    w.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "View", "aria-label": "View " + o.id, onclick: function () { details(o); } }));
    return w;
  }

  // Moves one dine-in order to a free table, or to another table of yours
  function moveOrder(o) {
    const picker = h("div", { class: "floor compact", role: "radiogroup", "aria-label": "New table" });
    let target = null;
    const ok = h("button", { class: "btn btn-primary", text: "Move order", disabled: true });
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no);
      const b = h("button", { type: "button", class: "tbl " + st.state, role: "radio", "aria-checked": "false", "aria-label": "Table " + t.no + ", " + st.label }, [h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" })]);
      if (t.no === o.table || st.state === "other") b.disabled = true;
      else b.addEventListener("click", function () {
        target = t.no;
        picker.querySelectorAll(".tbl").forEach(function (x) { x.classList.remove("selected"); x.setAttribute("aria-checked", "false"); });
        b.classList.add("selected"); b.setAttribute("aria-checked", "true");
        ok.disabled = false;
      });
      picker.appendChild(b);
    });
    let modal = document.getElementById("moveModal");
    if (modal) modal.remove();
    modal = h("div", { class: "modal-backdrop", id: "moveModal", role: "dialog", "aria-modal": "true", "aria-labelledby": "moveTitle" }, [
      h("div", { class: "modal" }, [
        h("div", { class: "modal-head" }, [h("div", { class: "icon-tile" }, [App.I("grid", 20)]), h("div", null, [h("h3", { id: "moveTitle", text: "Move " + o.id }), h("p", { text: "From Table " + o.table + " to a free table, or one you already serve." })])]),
        h("div", { class: "modal-body" }, [picker]),
        h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-secondary", "data-close": "moveModal", text: "Cancel" }), ok])
      ])
    ]);
    document.body.appendChild(modal);
    ok.addEventListener("click", function () {
      CMS.busy(ok, async function () {
        const moved = await CMS.attempt(function () { return Store.transfer(o.id, target); });
        if (moved) { CMS.closeModal("moveModal"); CMS.toast(o.id + " moved to Table " + target, "ok"); }
      });
    });
    CMS.openModal("moveModal");
  }

  // ----- My orders -----
  function renderOrders() {
    const all = mine().filter(function (o) { return isToday(o.createdAt) || Store.ACTIVE.indexOf(o.status) !== -1; });
    const sets = {
      active: all.filter(function (o) { return o.status === "Held" || Store.ACTIVE.indexOf(o.status) !== -1; }),
      Ready: all.filter(function (o) { return o.status === "Ready"; }),
      Served: all.filter(function (o) { return o.status === "Served"; }),
      all: all
    };
    Object.keys(sets).forEach(function (k) { const el = document.querySelector('[data-n="' + k + '"]'); if (el) el.textContent = sets[k].length; });
    const body = document.getElementById("ordersBody");
    body.replaceChildren();
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
        h("td", { text: where(o) }),
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
    list.replaceChildren();
    if (!ready.length) {
      list.appendChild(h("li", { class: "empty-li" }, [h("div", { class: "empty-state", icon: "check-circle", iconSize: 28 }, [h("b", { text: "All caught up" }), h("span", { text: "You'll get an alert when the kitchen finishes an order." })])]));
      return;
    }
    ready.forEach(function (o) {
      list.appendChild(h("li", { class: "pulse-in" }, [
        h("span", { class: "tno ok", text: o.type === "dine-in" ? "T" + o.table : (o.type === "delivery" ? "DL" : "TA") }),
        h("div", { class: "meta" }, [h("b", { text: o.id + " · ready " + CMS.timeAgo(o.updatedAt) }), h("small", { text: itemsSummary(o) })]),
        h("button", { class: "btn btn-success btn-sm", icon: "check", text: "Serve", "aria-label": "Mark " + o.id + " served", onclick: function () { serve(o); } })
      ]));
    });
  }

  // ----- Floor plan + table actions -----
  // The floor as laid out in Settings, one area at a time
  let floorArea = null;
  function renderFloor() {
    floorArea = FloorPlan.areaTabs(document.getElementById("floorAreas"), Store.TABLES, floorArea, function (a) { floorArea = a; renderFloor(); });
    FloorPlan.render(document.getElementById("floorMap"), Store.TABLES, {
      area: floorArea,
      decorate: function (btn, t) {
        const st = Store.tableState(t.no);
        btn.classList.add(st.state);
        btn.appendChild(h("span", { class: "st", text: st.label }));
        btn.setAttribute("aria-label", "Table " + t.no + ", " + t.seats + " seats, " + st.label);
        if (st.state === "other") btn.disabled = true;
      },
      onPick: function (t) {
        const st = Store.tableState(t.no);
        if (st.state === "free") location.href = "order.html?table=" + t.no;
        else if (st.state !== "other") tableActions(t, st);
      }
    });
  }
  function tableActions(t, st) {
    document.getElementById("tableTitle").textContent = "Table " + t.no + " · " + t.seats + " seats";
    document.getElementById("tableSub").textContent = st.label + " · " + st.orders.length + " open order" + (st.orders.length === 1 ? "" : "s");
    const body = document.getElementById("tableBody");
    body.replaceChildren();
    const lines = [];
    st.orders.forEach(function (o) { lines.push(h("div", { class: "row" }, [h("span", null, [h("b", { class: "mono", text: o.id }), " " + itemsSummary(o)]), pill(o.status)])); });
    const tt = Store.totals([].concat.apply([], st.orders.map(function (o) { return o.items; })));
    lines.push(h("div", { class: "row total" }, [h("span", { text: "Table total (incl. tax)" }), h("span", { text: CMS.money(tt.total) })]));
    body.appendChild(h("div", { class: "summary" }, lines));
    const actions = document.getElementById("tableActions");
    actions.replaceChildren();
    actions.appendChild(h("button", { class: "btn btn-secondary", "data-close": "tableModal", text: "Close" }));
    if (st.state === "bill") {
      body.appendChild(h("p", { class: "field-hint mt-12", text: "The cashier has been notified. The table becomes free once the bill is paid." }));
    } else {
      actions.appendChild(h("a", { class: "btn btn-secondary", href: "order.html?table=" + t.no, icon: "plus", text: "Add items" }));
      const req = h("button", { class: "btn btn-primary", icon: "receipt", text: "Request bill", "data-autofocus": true, onclick: function (e) {
        CMS.busy(e.currentTarget, async function () {
          const ok = await CMS.attempt(async function () { await Store.requestBill(t.no); return true; });
          if (ok) { CMS.closeModal("tableModal"); CMS.toast("Bill requested for Table " + t.no + ". The cashier has been notified.", "ok"); }
        });
      } });
      if (!st.served) { req.disabled = true; req.title = "Serve every order on this table first"; }
      actions.appendChild(req);
    }
    CMS.openModal("tableModal");
  }

  function renderUnavailable() {
    const list = document.getElementById("soldList");
    list.replaceChildren();
    const items = Store.menu().filter(function (m) { return !Store.isAvailable(m.id); });
    if (!items.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "Everything on the menu is available." })])); return; }
    items.forEach(function (m) {
      list.appendChild(h("li", null, [h("span", { class: "tno danger", icon: "x", iconSize: 18 }), h("div", { class: "meta" }, [h("b", { text: m.name }), h("small", { text: m.cat + " · " + Store.unavailableReason(m.id) })])]));
    });
  }
})();
