// Waiter "Take Order" page.
(function () {
  // ---- Session check (UX only; real enforcement will be server-side RBAC) ----
  const session = Session.get();
  if (!session) {
    window.location.replace("login.html");
    return;
  }
  document.getElementById("userName").textContent = session.user;
  document.getElementById("userRole").textContent = session.role;

  function logout(msg) {
    Session.clear();
    if (msg) {
      try { sessionStorage.setItem("cms_logout_msg", msg); } catch (e) {}
    }
    window.location.replace("login.html");
  }
  document.getElementById("logoutBtn").addEventListener("click", function () { logout(); });

  // Auto sign-out after inactivity (mirrors SR-6)
  const IDLE_MS = 5 * 60 * 1000;
  let idleTimer;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { logout("You were signed out after 5 minutes of inactivity."); }, IDLE_MS);
  }
  ["click", "keydown", "mousemove", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, resetIdle, { passive: true });
  });
  resetIdle();

  // ---- Sample data (will come from the backend API later) ----
  const MENU = [
    { id: 1, name: "Espresso", cat: "Coffee", price: 350, available: true },
    { id: 2, name: "Cappuccino", cat: "Coffee", price: 520, available: true },
    { id: 3, name: "Caffe Latte", cat: "Coffee", price: 550, available: true },
    { id: 4, name: "Caramel Macchiato", cat: "Coffee", price: 650, available: true },
    { id: 5, name: "Iced Americano", cat: "Cold Drinks", price: 480, available: true },
    { id: 6, name: "Mango Smoothie", cat: "Cold Drinks", price: 590, available: false },
    { id: 7, name: "Fresh Lime Soda", cat: "Cold Drinks", price: 300, available: true },
    { id: 8, name: "Green Tea", cat: "Tea", price: 250, available: true },
    { id: 9, name: "Karak Chai", cat: "Tea", price: 220, available: true },
    { id: 10, name: "Chicken Club Sandwich", cat: "Food", price: 890, available: true },
    { id: 11, name: "Grilled Panini", cat: "Food", price: 820, available: true },
    { id: 12, name: "Loaded Fries", cat: "Food", price: 560, available: true },
    { id: 13, name: "Chocolate Brownie", cat: "Desserts", price: 420, available: true },
    { id: 14, name: "Blueberry Cheesecake", cat: "Desserts", price: 690, available: false },
    { id: 15, name: "Butter Croissant", cat: "Desserts", price: 380, available: true }
  ];
  const TABLES = [
    { no: 1, occupied: false }, { no: 2, occupied: true }, { no: 3, occupied: false },
    { no: 4, occupied: false }, { no: 5, occupied: true }, { no: 6, occupied: false },
    { no: 7, occupied: false }, { no: 8, occupied: true }
  ];
  const TAX = 0.16;

  let selectedTable = null;
  let activeCat = "All";
  const order = new Map(); // id -> qty
  const sent = [];

  const fmt = function (n) { return "Rs " + Math.round(n).toLocaleString(); };
  const el = function (tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ---- Tables ----
  const tablesEl = document.getElementById("tables");
  function renderTables() {
    tablesEl.innerHTML = "";
    TABLES.forEach(function (t) {
      const b = el("button", "table-btn " + (t.occupied ? "occupied" : "free"));
      if (selectedTable === t.no) b.classList.add("selected");
      b.textContent = "T" + t.no;
      b.appendChild(el("small", null, t.occupied ? "Occupied" : "Free"));
      b.setAttribute("aria-pressed", selectedTable === t.no ? "true" : "false");
      b.addEventListener("click", function () {
        selectedTable = t.no;
        renderTables();
        renderOrder();
      });
      tablesEl.appendChild(b);
    });
  }

  // ---- Interaction: category filter + live search ----
  const chipsEl = document.getElementById("categoryChips");
  const searchEl = document.getElementById("search");
  const cats = ["All"].concat(Array.from(new Set(MENU.map(function (m) { return m.cat; }))));

  function renderChips() {
    chipsEl.innerHTML = "";
    cats.forEach(function (c) {
      const b = el("button", "chip" + (c === activeCat ? " active" : ""), c);
      b.setAttribute("aria-pressed", c === activeCat ? "true" : "false");
      b.addEventListener("click", function () { activeCat = c; renderChips(); renderMenu(); });
      chipsEl.appendChild(b);
    });
  }

  const menuEl = document.getElementById("menuGrid");
  function renderMenu() {
    const q = searchEl.value.trim().toLowerCase();
    const items = MENU.filter(function (m) {
      return (activeCat === "All" || m.cat === activeCat) && m.name.toLowerCase().includes(q);
    });
    menuEl.innerHTML = "";
    if (!items.length) {
      menuEl.appendChild(el("p", "empty", "No items match your search."));
      return;
    }
    items.forEach(function (m) {
      const card = el("div", "menu-item" + (m.available ? "" : " unavailable"));
      card.appendChild(el("span", "cat", m.cat));
      card.appendChild(el("span", "name", m.name));
      const row = el("div", "row");
      row.appendChild(el("span", "price", fmt(m.price)));
      const add = el("button", "btn btn-dark btn-sm", m.available ? "+ Add" : "Sold out");
      add.disabled = !m.available;
      add.setAttribute("aria-label", "Add " + m.name);
      add.addEventListener("click", function () { changeQty(m.id, 1); });
      row.appendChild(add);
      card.appendChild(row);
      menuEl.appendChild(card);
    });
  }
  searchEl.addEventListener("input", renderMenu);

  // ---- Interaction: add / remove items, live totals ----
  function changeQty(id, delta) {
    const q = (order.get(id) || 0) + delta;
    if (q <= 0) order.delete(id);
    else order.set(id, Math.min(q, 20));
    renderOrder();
  }

  const linesEl = document.getElementById("orderLines");
  const sendBtn = document.getElementById("sendBtn");
  function calcTotals() {
    let sub = 0;
    order.forEach(function (qty, id) { sub += MENU.find(function (m) { return m.id === id; }).price * qty; });
    return { sub: sub, tax: sub * TAX, total: sub * (1 + TAX) };
  }

  function renderOrder() {
    document.getElementById("selectedTable").textContent = selectedTable ? "Table " + selectedTable : "no table";
    linesEl.innerHTML = "";
    order.forEach(function (qty, id) {
      const m = MENU.find(function (x) { return x.id === id; });
      const li = el("li");
      li.appendChild(el("span", "line-name", m.name));
      const qtyBox = el("span", "qty");
      const minus = el("button", null, "−");
      minus.setAttribute("aria-label", "Remove one " + m.name);
      minus.addEventListener("click", function () { changeQty(id, -1); });
      const plus = el("button", null, "+");
      plus.setAttribute("aria-label", "Add one " + m.name);
      plus.addEventListener("click", function () { changeQty(id, 1); });
      qtyBox.append(minus, el("span", null, String(qty)), plus);
      li.appendChild(qtyBox);
      li.appendChild(el("span", "line-total", fmt(m.price * qty)));
      linesEl.appendChild(li);
    });
    document.getElementById("orderEmpty").style.display = order.size ? "none" : "block";

    const t = calcTotals();
    document.getElementById("subtotal").textContent = fmt(t.sub);
    document.getElementById("tax").textContent = fmt(t.tax);
    document.getElementById("total").textContent = fmt(t.total);
    sendBtn.disabled = !(order.size && selectedTable);
    const hint = !selectedTable ? "Select a table first." : !order.size ? "Add at least one item." : "";
    sendBtn.title = hint;
    document.getElementById("sendHint").textContent = hint;
  }

  // ---- Interaction: notes character counter ----
  const notesEl = document.getElementById("notes");
  const counterEl = document.getElementById("notesCounter");
  notesEl.addEventListener("input", function () {
    const n = notesEl.value.length;
    counterEl.textContent = n + " / " + notesEl.maxLength;
    counterEl.classList.toggle("warn", n > notesEl.maxLength - 15);
  });

  // ---- Clear order ----
  document.getElementById("clearBtn").addEventListener("click", function () {
    if (!order.size) return;
    if (confirm("Remove all items from this order?")) {
      order.clear();
      notesEl.value = "";
      notesEl.dispatchEvent(new Event("input"));
      renderOrder();
    }
  });

  // ---- Interaction: confirmation modal ----
  const modal = document.getElementById("confirmModal");
  const modalBody = document.getElementById("modalBody");
  sendBtn.addEventListener("click", function () {
    modalBody.innerHTML = "";
    modalBody.appendChild(el("p", null, "Table " + selectedTable + " · " + fmt(calcTotals().total)));
    const ul = el("ul");
    order.forEach(function (qty, id) {
      ul.appendChild(el("li", null, qty + " × " + MENU.find(function (m) { return m.id === id; }).name));
    });
    modalBody.appendChild(ul);
    const note = notesEl.value.trim();
    if (note) modalBody.appendChild(el("p", null, "Note: " + note)); // textContent → safe from XSS
    modal.classList.add("show");
    document.getElementById("modalConfirm").focus();
  });

  function closeModal() { modal.classList.remove("show"); sendBtn.focus(); }
  document.getElementById("modalCancel").addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal.classList.contains("show")) closeModal(); });

  document.getElementById("modalConfirm").addEventListener("click", function () {
    const id = "ORD-" + String(1000 + sent.length + 1);
    const count = Array.from(order.values()).reduce(function (a, b) { return a + b; }, 0);
    const newOrder = { id: id, table: selectedTable, items: count, total: calcTotals().total, status: "Placed" };
    sent.unshift(newOrder);
    simulateKitchen(newOrder);

    const tbl = TABLES.find(function (t) { return t.no === selectedTable; });
    if (tbl) tbl.occupied = true;

    order.clear();
    notesEl.value = "";
    notesEl.dispatchEvent(new Event("input"));
    modal.classList.remove("show");
    renderTables();
    renderOrder();
    renderRecent();
    showToast("✓ " + id + " sent to kitchen", "ok");
  });

  // ---- Interaction: order status tracking (Placed → Preparing → Ready → Served) ----
  // Prototype: the kitchen is simulated with timers. Later, Kitchen Staff will
  // update status from their own screen and the waiter will receive it from the API.
  function simulateKitchen(o) {
    setTimeout(function () {
      if (o.status !== "Placed") return;
      o.status = "Preparing";
      renderRecent();
    }, 5000);
    setTimeout(function () {
      if (o.status !== "Preparing") return;
      o.status = "Ready";
      renderRecent();
      showToast("🔔 " + o.id + " for Table " + o.table + " is ready to serve", "ok");
    }, 12000);
  }

  function updateStatus(o, status) {
    o.status = status;
    if (status === "Served" || status === "Cancelled") {
      const stillOpen = sent.some(function (x) {
        return x.table === o.table && x !== o && ["Placed", "Preparing", "Ready"].includes(x.status);
      });
      const tbl = TABLES.find(function (t) { return t.no === o.table; });
      if (tbl && !stillOpen && status === "Cancelled") tbl.occupied = false;
      renderTables();
    }
    renderRecent();
    showToast(o.id + " marked " + status.toLowerCase(), status === "Cancelled" ? "err" : "ok");
  }

  const recentEl = document.getElementById("recentOrders");
  function renderRecent() {
    recentEl.innerHTML = "";
    sent.slice(0, 6).forEach(function (o) {
      const li = el("li");
      li.appendChild(el("span", "line-name", o.id + " · T" + o.table + " · " + o.items + " items"));
      if (o.status === "Placed") {
        const cancel = el("button", "btn btn-ghost btn-sm", "Cancel");
        cancel.setAttribute("aria-label", "Cancel " + o.id);
        cancel.addEventListener("click", function () {
          if (confirm("Cancel " + o.id + "? The kitchen hasn't started it yet.")) updateStatus(o, "Cancelled");
        });
        li.appendChild(cancel);
      } else if (o.status === "Ready") {
        const served = el("button", "btn btn-primary btn-sm", "Mark served");
        served.setAttribute("aria-label", "Mark " + o.id + " served");
        served.addEventListener("click", function () { updateStatus(o, "Served"); });
        li.appendChild(served);
      }
      li.appendChild(el("span", "status status-" + o.status.toLowerCase(), o.status));
      recentEl.appendChild(li);
    });
    document.getElementById("recentEmpty").style.display = sent.length ? "none" : "block";
  }

  renderTables();
  renderChips();
  renderMenu();
  renderOrder();
  renderRecent();
})();
