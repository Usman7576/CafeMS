// Take order / edit order: table picker, menu search + category filter,
// ticket with quantity steppers and live totals, notes counter, confirmation.
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  const MAX_QTY = 20;
  let selectedTable = null, activeCat = "All", editing = null;
  const lines = new Map(); // menu id -> qty

  document.addEventListener("DOMContentLoaded", function () {
    const params = new URLSearchParams(location.search);
    const editId = params.get("edit");
    if (editId) {
      const o = Store.order(editId);
      if (!o || o.waiter !== me || o.status !== "Placed") {
        CMS.toast(o ? "The kitchen has already started " + editId + ". Send a new order for extra items." : "Order not found.", "err");
      } else {
        editing = o;
        selectedTable = o.table;
        o.items.forEach(function (i) { lines.set(i.id, i.qty); });
        document.getElementById("notes").value = o.notes || "";
        document.getElementById("orderHeading").textContent = "Edit " + o.id;
        document.getElementById("orderIntro").textContent = "Change items or notes. You can edit until the kitchen starts preparing it.";
        document.getElementById("sendLabel").textContent = "Update order";
        document.getElementById("tableStep").classList.add("locked");
      }
    } else {
      const q = parseInt(params.get("table"), 10);
      if (Store.TABLES.some(function (t) { return t.no === q; }) && Store.tableState(q, me).state !== "other") selectedTable = q;
    }

    // Sticky "view ticket" bar for phones and tablets, where the ticket sits below the menu
    const bar = h("button", { type: "button", class: "mobile-cart", id: "mobileCart", onclick: function () {
      document.querySelector(".ticket").scrollIntoView({ behavior: "smooth", block: "start" });
    } }, [h("span", { class: "mc-count", id: "mcCount" }), h("span", { class: "mc-label", text: "View ticket" }), h("span", { class: "mc-total", id: "mcTotal" })]);
    document.body.appendChild(bar);

    renderTables(); renderCats(); renderMenu(); renderTicket(); updateCounter();

    const search = document.getElementById("search");
    search.addEventListener("input", renderMenu);
    search.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.target.value = ""; renderMenu(); } });
    document.getElementById("notes").addEventListener("input", updateCounter);
    document.getElementById("clearBtn").addEventListener("click", clearTicket);
    document.getElementById("sendBtn").addEventListener("click", openConfirm);
    document.getElementById("confirmSend").addEventListener("click", send);

    Store.on(function () {
      renderTables(); renderMenu();
      if (editing) {
        const o = Store.order(editing.id);
        if (o && o.status !== "Placed") {
          CMS.toast("The kitchen just started " + o.id + ". Your edits can't be saved.", "err");
          editing = null; lines.clear(); location.replace("dashboard.html");
        }
      }
    });
    window.addEventListener("beforeunload", function (e) { if (lines.size && !editing) { e.preventDefault(); e.returnValue = ""; } });
  });

  function updateCounter() {
    const notes = document.getElementById("notes"), counter = document.getElementById("notesCounter");
    const n = notes.value.length;
    counter.textContent = n + " / " + notes.maxLength;
    counter.classList.toggle("warn", n >= notes.maxLength - 15);
  }

  // ----- Step 1: tables -----
  function renderTables() {
    const wrap = document.getElementById("tablePicker");
    wrap.innerHTML = "";
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no, me);
      const isSel = selectedTable === t.no;
      const b = h("button", { class: "tbl " + st.state + (isSel ? " selected" : ""), type: "button", role: "radio",
        "aria-checked": String(isSel), "aria-label": "Table " + t.no + ", " + t.seats + " seats, " + st.label },
        [h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" }), h("span", { class: "st", text: st.label })]);
      if (st.state === "other" || (editing && t.no !== editing.table)) b.disabled = true;
      else b.addEventListener("click", function () { selectedTable = t.no; renderTables(); renderTicket(); });
      wrap.appendChild(b);
    });
  }

  // ----- Step 2: categories + search -----
  function renderCats() {
    const menu = Store.menu();
    const cats = ["All"].concat(Store.categories());
    const wrap = document.getElementById("catTabs");
    wrap.innerHTML = "";
    cats.forEach(function (c) {
      const n = c === "All" ? menu.length : menu.filter(function (m) { return m.cat === c; }).length;
      wrap.appendChild(h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(c === activeCat),
        onclick: function () { activeCat = c; renderCats(); renderMenu(); } }, [c + " ", h("span", { class: "n", text: String(n) })]));
    });
  }
  function renderMenu() {
    const q = document.getElementById("search").value.trim().toLowerCase();
    const items = Store.menu().filter(function (m) {
      return (activeCat === "All" || m.cat === activeCat) && (m.name.toLowerCase().indexOf(q) !== -1 || m.desc.toLowerCase().indexOf(q) !== -1);
    });
    const grid = document.getElementById("menuGrid");
    grid.innerHTML = "";
    if (!items.length) {
      grid.appendChild(h("div", { class: "empty-state", icon: "search", iconSize: 30 }, [h("b", { text: "No items match your search" }), h("span", { text: "Try a different word or category." })]));
      return;
    }
    items.forEach(function (m) {
      const qty = lines.get(m.id) || 0;
      const avail = Store.isAvailable(m.id);
      grid.appendChild(h("article", { class: "dish" + (avail ? "" : " soldout") + (qty ? " picked" : "") }, [
        h("div", { class: "dish-top" }, [h("span", { class: "cat", text: m.cat }), qty ? h("span", { class: "qty-badge", text: "× " + qty }) : null]),
        h("span", { class: "name", text: m.name }),
        h("span", { class: "desc", text: m.desc }),
        h("div", { class: "foot" }, [
          h("span", { class: "price", text: CMS.money(m.price) }),
          avail
            ? h("button", { class: "btn btn-dark btn-sm", type: "button", icon: "plus", iconSize: 15, text: "Add", "aria-label": "Add " + m.name, onclick: function () { change(m.id, 1); } })
            : h("span", { class: "pill pill-cancelled", title: Store.unavailableReason(m.id), text: "Sold out" })
        ])
      ]));
    });
  }

  // ----- Ticket -----
  function change(id, delta) {
    const q = (lines.get(id) || 0) + delta;
    if (q <= 0) lines.delete(id);
    else if (q > MAX_QTY) { CMS.toast("Maximum " + MAX_QTY + " of one item per order", "err"); return; }
    else lines.set(id, q);
    renderTicket(); renderMenu();
  }
  function currentItems() {
    return Array.from(lines.entries()).map(function (e) {
      const m = Store.menuItem(e[0]);
      return m ? { id: m.id, name: m.name, price: m.price, qty: e[1] } : null;
    }).filter(Boolean);
  }
  function renderTicket() {
    const items = currentItems(), t = Store.totals(items);
    const list = document.getElementById("ticketLines");
    list.innerHTML = "";
    items.forEach(function (it) {
      list.appendChild(h("li", null, [
        h("span", { class: "nm" }, [it.name, h("small", { text: CMS.money(it.price) + " each" })]),
        h("span", { class: "stepper" }, [
          h("button", { type: "button", icon: it.qty === 1 ? "trash" : "minus", iconSize: 14, "aria-label": "Remove one " + it.name, onclick: function () { change(it.id, -1); } }),
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
    const bar = document.getElementById("mobileCart");
    if (bar) {
      bar.classList.toggle("show", t.count > 0);
      document.getElementById("mcCount").textContent = String(t.count);
      document.getElementById("mcTotal").textContent = CMS.money(t.total);
    }
    document.getElementById("ticketTable").textContent = selectedTable
      ? "Table " + selectedTable + " · " + Store.TABLES.find(function (x) { return x.no === selectedTable; }).seats + " seats" + (editing ? " · editing " + editing.id : "")
      : "No table selected";
    const hint = !selectedTable ? "Select a table to continue." : !items.length ? "Add at least one item." : "";
    document.getElementById("sendBtn").disabled = !!hint;
    const hintEl = document.getElementById("sendHint");
    hintEl.innerHTML = "";
    if (hint) { hintEl.insertAdjacentHTML("afterbegin", Icons.svg("info", 14)); hintEl.appendChild(document.createTextNode(hint)); }
  }

  async function clearTicket() {
    if (!lines.size) return;
    const ok = await CMS.confirm({ title: "Clear this ticket?", message: "All items and notes on the ticket will be removed.", okText: "Clear ticket", danger: true, icon: "trash" });
    if (ok) resetTicket();
  }
  function resetTicket() {
    lines.clear();
    document.getElementById("notes").value = "";
    updateCounter(); renderTicket(); renderMenu();
  }

  // ----- Confirm & send -----
  function openConfirm() {
    const items = currentItems(), t = Store.totals(items);
    document.getElementById("confirmTitle").textContent = editing ? "Update " + editing.id + "?" : "Send order to kitchen?";
    document.getElementById("confirmSub").textContent = "Table " + selectedTable + " · " + t.count + (t.count === 1 ? " item" : " items") + ". Read the order back to the guest before sending.";
    const body = document.getElementById("confirmBody");
    body.innerHTML = "";
    const box = h("div", { class: "summary" });
    items.forEach(function (it) { box.appendChild(h("div", { class: "row" }, [h("span", { text: it.qty + " × " + it.name }), h("span", { text: CMS.money(it.price * it.qty) })])); });
    box.appendChild(h("div", { class: "row" }, [h("span", { class: "muted", text: "Tax (16%)" }), h("span", { class: "muted", text: CMS.money(t.tax) })]));
    box.appendChild(h("div", { class: "row total" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(t.total) })]));
    const note = document.getElementById("notes").value.trim();
    if (note) box.appendChild(h("div", { class: "note", text: "Kitchen note: " + note })); // rendered as text, never HTML
    body.appendChild(box);
    document.getElementById("confirmSend").textContent = editing ? "Save changes" : "Confirm & send";
    CMS.openModal("confirmModal");
  }
  function send() {
    const note = document.getElementById("notes").value.trim().slice(0, 120);
    const list = Array.from(lines.entries()).map(function (e) { return { id: e[0], qty: e[1] }; });
    const o = CMS.attempt(function () { return editing ? Store.updateOrder(editing.id, list, note, me) : Store.place(selectedTable, list, note, me); });
    CMS.closeModal("confirmModal");
    if (!o) { renderMenu(); return; }
    if (editing) {
      editing = null; lines.clear();
      CMS.toast(o.id + " updated", "ok");
      setTimeout(function () { location.href = "dashboard.html"; }, 700);
      return;
    }
    CMS.toast(o.id + " sent to the kitchen for Table " + o.table, "ok");
    selectedTable = null;
    resetTicket(); renderTables();
  }
})();
