// Take order: table picker, menu search + category filter, order ticket with
// quantity steppers and live totals, kitchen-notes counter, confirmation modal.
(function () {
  if (!window.App) return;
  const h = CMS.h;

  let selectedTable = null;
  let activeCat = "All";
  const lines = new Map(); // menu id -> qty
  const MAX_QTY = 20;

  document.addEventListener("DOMContentLoaded", function () {
    // Preselect table from dashboard link (?table=N), only if it's selectable.
    const q = parseInt(new URLSearchParams(location.search).get("table"), 10);
    if (Store.TABLES.some(function (t) { return t.no === q; }) && Store.tableState(q).state !== "other") selectedTable = q;

    renderTables();
    renderCats();
    renderMenu();
    renderTicket();

    document.getElementById("search").addEventListener("input", renderMenu);
    document.getElementById("search").addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.target.value = ""; renderMenu(); }
    });

    // ----- Interaction: notes character counter -----
    const notes = document.getElementById("notes");
    const counter = document.getElementById("notesCounter");
    notes.addEventListener("input", function () {
      const n = notes.value.length;
      counter.textContent = n + " / " + notes.maxLength;
      counter.classList.toggle("warn", n >= notes.maxLength - 15);
    });

    document.getElementById("clearBtn").addEventListener("click", clearTicket);
    document.getElementById("sendBtn").addEventListener("click", openConfirm);
    document.getElementById("confirmSend").addEventListener("click", sendOrder);

    Store.on(renderTables);

    // Warn before leaving with an unsent order
    window.addEventListener("beforeunload", function (e) {
      if (lines.size) { e.preventDefault(); e.returnValue = ""; }
    });
  });

  // ----- Step 1: tables -----
  function renderTables() {
    const wrap = document.getElementById("tablePicker");
    wrap.innerHTML = "";
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no);
      const isSel = selectedTable === t.no;
      const b = h("button", {
        class: "tbl " + st.state + (isSel ? " selected" : ""), type: "button", role: "radio",
        "aria-checked": String(isSel), "aria-label": "Table " + t.no + ", " + t.seats + " seats, " + st.label
      }, [h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" }), h("span", { class: "st", text: st.label })]);
      if (st.state === "other") b.disabled = true;
      else b.addEventListener("click", function () { selectedTable = t.no; renderTables(); renderTicket(); });
      wrap.appendChild(b);
    });
  }

  // ----- Step 2: category tabs + search -----
  function renderCats() {
    const cats = ["All"].concat(Array.from(new Set(Store.MENU.map(function (m) { return m.cat; }))));
    const wrap = document.getElementById("catTabs");
    wrap.innerHTML = "";
    cats.forEach(function (c) {
      const n = c === "All" ? Store.MENU.length : Store.MENU.filter(function (m) { return m.cat === c; }).length;
      wrap.appendChild(h("button", {
        class: "tab", role: "tab", type: "button", "aria-selected": String(c === activeCat),
        onclick: function () { activeCat = c; renderCats(); renderMenu(); }
      }, [c + " ", h("span", { class: "n", text: String(n) })]));
    });
  }

  function renderMenu() {
    const q = document.getElementById("search").value.trim().toLowerCase();
    const items = Store.MENU.filter(function (m) {
      return (activeCat === "All" || m.cat === activeCat) &&
        (m.name.toLowerCase().indexOf(q) !== -1 || m.desc.toLowerCase().indexOf(q) !== -1);
    });
    const grid = document.getElementById("menuGrid");
    grid.innerHTML = "";
    if (!items.length) {
      grid.appendChild(h("div", { class: "empty-state", icon: "search", iconSize: 30 }, [
        h("b", { text: "No items match your search" }), h("span", { text: "Try a different word or category." })
      ]));
      return;
    }
    items.forEach(function (m) {
      const qty = lines.get(m.id) || 0;
      grid.appendChild(h("article", { class: "dish" + (m.available ? "" : " soldout") }, [
        h("span", { class: "cat", text: m.cat }),
        h("span", { class: "name", text: m.name }),
        h("span", { class: "desc", text: m.desc }),
        h("div", { class: "foot" }, [
          h("span", null, [h("span", { class: "price", text: CMS.money(m.price) }), qty ? h("span", { class: "in-order", text: qty + " in order" }) : null]),
          m.available
            ? h("button", { class: "btn btn-dark btn-sm", type: "button", icon: "plus", iconSize: 15, text: "Add", "aria-label": "Add " + m.name, onclick: function () { change(m.id, 1); } })
            : h("span", { class: "pill pill-cancelled", text: "Sold out" })
        ])
      ]));
    });
  }

  // ----- Interaction: add / remove items with live totals -----
  function change(id, delta) {
    const q = (lines.get(id) || 0) + delta;
    if (q <= 0) lines.delete(id);
    else if (q > MAX_QTY) { CMS.toast("Maximum " + MAX_QTY + " of one item per order", "err"); return; }
    else lines.set(id, q);
    renderTicket();
    renderMenu();
  }

  function currentItems() {
    return Array.from(lines.entries()).map(function (e) { const m = Store.menuItem(e[0]); return { id: m.id, name: m.name, price: m.price, qty: e[1] }; });
  }

  function renderTicket() {
    const items = currentItems();
    const t = Store.totals(items);
    const list = document.getElementById("ticketLines");
    list.innerHTML = "";
    items.forEach(function (it) {
      list.appendChild(h("li", null, [
        h("span", { class: "nm" }, [it.name, h("small", { text: CMS.money(it.price) + " each" })]),
        h("span", { class: "stepper" }, [
          h("button", { type: "button", icon: "minus", iconSize: 14, "aria-label": "Remove one " + it.name, onclick: function () { change(it.id, -1); } }),
          h("span", { text: String(it.qty), "aria-live": "polite" }),
          h("button", { type: "button", icon: "plus", iconSize: 14, "aria-label": "Add one " + it.name, onclick: function () { change(it.id, 1); } })
        ]),
        h("span", { class: "amt", text: CMS.money(it.price * it.qty) })
      ]));
    });
    document.getElementById("ticketEmpty").style.display = items.length ? "none" : "";
    document.getElementById("itemCount").textContent = t.count + (t.count === 1 ? " item" : " items");
    document.getElementById("subtotal").textContent = CMS.money(t.sub);
    document.getElementById("tax").textContent = CMS.money(t.tax);
    document.getElementById("total").textContent = CMS.money(t.total);
    document.getElementById("ticketTable").textContent = selectedTable
      ? "Table " + selectedTable + " · " + Store.TABLES.find(function (x) { return x.no === selectedTable; }).seats + " seats"
      : "No table selected";

    const hint = !selectedTable ? "Select a table to continue." : !items.length ? "Add at least one item." : "";
    const sendBtn = document.getElementById("sendBtn");
    sendBtn.disabled = !!hint;
    const hintEl = document.getElementById("sendHint");
    hintEl.innerHTML = "";
    if (hint) { hintEl.insertAdjacentHTML("afterbegin", Icons.svg("info", 14)); hintEl.appendChild(document.createTextNode(hint)); }
  }

  async function clearTicket() {
    if (!lines.size) return;
    const ok = await CMS.confirm({ title: "Clear this order?", message: "All items and notes on the ticket will be removed.", okText: "Clear order", danger: true, icon: "trash" });
    if (!ok) return;
    resetTicket();
  }
  function resetTicket() {
    lines.clear();
    const notes = document.getElementById("notes");
    notes.value = "";
    notes.dispatchEvent(new Event("input"));
    renderTicket();
    renderMenu();
  }

  // ----- Interaction: confirmation modal -----
  function openConfirm() {
    const items = currentItems();
    const t = Store.totals(items);
    document.getElementById("confirmSub").textContent = "Table " + selectedTable + " · " + t.count + (t.count === 1 ? " item" : " items") + ". Check the order with the guest before sending.";
    const body = document.getElementById("confirmBody");
    body.innerHTML = "";
    const box = h("div", { class: "summary" });
    items.forEach(function (it) {
      box.appendChild(h("div", { class: "row" }, [h("span", { text: it.qty + " × " + it.name }), h("span", { text: CMS.money(it.price * it.qty) })]));
    });
    box.appendChild(h("div", { class: "row" }, [h("span", { class: "muted", text: "Tax (16%)" }), h("span", { class: "muted", text: CMS.money(t.tax) })]));
    box.appendChild(h("div", { class: "row total" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(t.total) })]));
    const note = document.getElementById("notes").value.trim();
    if (note) box.appendChild(h("div", { class: "note", text: "Kitchen note: " + note })); // rendered as text, never HTML
    body.appendChild(box);
    CMS.openModal("confirmModal");
  }

  function sendOrder() {
    const note = document.getElementById("notes").value.trim().slice(0, 120);
    const lineList = Array.from(lines.entries()).map(function (e) { return { id: e[0], qty: e[1] }; });
    const o = Store.place(selectedTable, lineList, note, App.session.user);
    CMS.closeModal("confirmModal");
    CMS.toast(o.id + " sent to the kitchen for Table " + o.table, "ok");
    selectedTable = null;
    resetTicket();
    renderTables();
  }
})();
