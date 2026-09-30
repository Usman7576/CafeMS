// Billing: open tables → bill with role-limited discount → payment → receipt.
// Card payments go through the (simulated) payment gateway; card details are
// never entered or stored here (SR-8). Refunds are manager-only (SR-3, SR-7).
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user, role = App.session.role;
  const limit = Store.DISCOUNT_LIMIT[role] || 0;
  const DISCOUNTS = [0, 5, 10, 15, 20, 25];
  let selected = null, discount = 0, method = "Cash", tendered = "", query = "";

  document.addEventListener("DOMContentLoaded", function () {
    const m = /^#t(\d+)$/.exec(location.hash);
    if (m) selected = Number(m[1]);
    renderAll();
    Store.on(renderAll);
    document.getElementById("billSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); renderBills(); });
    document.getElementById("printReceipt").addEventListener("click", function () { window.print(); });
  });

  function renderAll() { renderStats(); renderTables(); renderBill(); renderBills(); }

  function renderStats() {
    const s = Store.salesToday(), open = Store.openTables();
    const box = document.getElementById("billStats");
    box.innerHTML = "";
    [["Collected today", CMS.money(s.revenue)], ["Bills", String(s.bills)], ["Open tables", String(open.length)]].forEach(function (x) {
      box.appendChild(h("div", { class: "stat-chip" }, [h("small", { text: x[0] }), h("b", { text: x[1] })]));
    });
  }

  // ----- Open tables -----
  function renderTables() {
    const wrap = document.getElementById("openTables");
    const open = Store.openTables().sort(function (a, b) { return (b.billRequested ? 1 : 0) - (a.billRequested ? 1 : 0) || a.since - b.since; });
    if (selected && !open.some(function (t) { return t.no === selected; })) selected = null;
    wrap.innerHTML = "";
    if (!open.length) {
      wrap.appendChild(h("div", { class: "empty-state", icon: "receipt", iconSize: 32 }, [h("b", { text: "No open tables" }), h("span", { text: "Tables appear here as soon as a waiter sends an order." })]));
      return;
    }
    open.forEach(function (t) {
      const state = t.billRequested ? ["Bill requested", "pill-bill"] : t.allServed ? ["Ready to bill", "pill-ready"] : ["Still being served", "pill-preparing"];
      wrap.appendChild(h("button", { type: "button", class: "table-card" + (selected === t.no ? " selected" : "") + (t.billRequested ? " attention" : ""), "aria-pressed": String(selected === t.no),
        onclick: function () { selected = t.no; discount = 0; tendered = ""; history.replaceState(null, "", "#t" + t.no); renderTables(); renderBill();
          if (window.innerWidth <= 1100) document.getElementById("billPanel").scrollIntoView({ behavior: "smooth", block: "start" }); } }, [
        h("div", { class: "tc-top" }, [h("span", { class: "tc-no", text: "T" + t.no }), h("span", { class: "pill " + state[1], text: state[0] })]),
        h("div", { class: "tc-total", text: CMS.money(t.totals.total) }),
        h("div", { class: "tc-meta", text: t.totals.count + " items · " + t.orders.length + " order" + (t.orders.length === 1 ? "" : "s") + " · " + t.waiters.join(", ") }),
        h("div", { class: "tc-meta", text: "Seated " + CMS.timeAgo(t.since) })
      ]));
    });
  }

  // ----- Bill panel -----
  function renderBill() {
    const body = document.getElementById("billBody");
    const tab = selected ? Store.openTables().find(function (t) { return t.no === selected; }) : null;
    body.innerHTML = "";
    document.getElementById("billState").textContent = "";
    if (!tab) {
      document.getElementById("billTitle").textContent = "Bill";
      document.getElementById("billSub").textContent = "Select a table to start";
      body.appendChild(h("div", { class: "empty-state", icon: "clipboard", iconSize: 36 }, [h("b", { text: "No table selected" }), h("span", { text: "Choose an open table on the left to prepare its bill." })]));
      return;
    }
    const t = Store.totals(tab.lines, discount);
    document.getElementById("billTitle").textContent = "Table " + tab.no;
    document.getElementById("billSub").textContent = tab.orders.map(function (o) { return o.id; }).join(", ") + " · " + tab.waiters.join(", ");
    document.getElementById("billState").textContent = tab.totals.count + " items";

    const lines = h("ul", { class: "bill-lines" }, tab.lines.map(function (l) {
      return h("li", null, [h("span", { class: "q", text: l.qty + "×" }), h("span", { class: "n", text: l.name }), h("span", { class: "a", text: CMS.money(l.price * l.qty) })]);
    }));

    // Discount (role-limited)
    const discRow = h("div", { class: "seg", role: "radiogroup", "aria-label": "Discount" }, DISCOUNTS.map(function (d) {
      const over = d > limit;
      return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(d === discount), disabled: over ? true : null,
        title: over ? "Needs manager approval" : null, text: d ? d + "%" : "None", onclick: function () { discount = d; renderBill(); } });
    }));

    // Payment method
    const methods = [["Cash", "cash"], ["Card", "card"], ["Wallet", "wallet"]];
    const methodRow = h("div", { class: "seg", role: "radiogroup", "aria-label": "Payment method" }, methods.map(function (m) {
      return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(m[0] === method), icon: m[1], iconSize: 15, text: m[0] === "Wallet" ? "Mobile wallet" : m[0],
        onclick: function () { method = m[0]; renderBill(); } });
    }));

    let payExtra;
    if (method === "Cash") {
      const input = h("input", { class: "input", id: "tendered", type: "number", min: String(t.total), step: "10", inputmode: "numeric", value: tendered, placeholder: String(t.total), "aria-label": "Cash received" });
      const change = h("div", { class: "change", id: "changeBox" });
      const updateChange = function () {
        tendered = input.value;
        const v = Number(input.value);
        change.textContent = input.value === "" ? "Enter the cash received" : v >= t.total ? "Change due: " + CMS.money(v - t.total) : "Short by " + CMS.money(t.total - v);
        change.className = "change " + (input.value === "" ? "" : v >= t.total ? "ok" : "bad");
        payBtn.disabled = !(v >= t.total) || !tab.allServed;
      };
      input.addEventListener("input", updateChange);
      const quick = [t.total, Math.ceil(t.total / 500) * 500, Math.ceil(t.total / 1000) * 1000, Math.ceil(t.total / 5000) * 5000]
        .filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 4);
      payExtra = h("div", { class: "cash-box" }, [
        h("label", { class: "label", for: "tendered", text: "Cash received" }),
        h("div", { class: "input-group" }, [h("span", { class: "addon", text: "Rs" }), input]),
        h("div", { class: "quick" }, quick.map(function (v) { return h("button", { type: "button", class: "chip-btn", text: CMS.money(v), onclick: function () { input.value = v; updateChange(); } }); })),
        change
      ]);
      setTimeout(updateChange, 0);
    } else {
      payExtra = h("div", { class: "gateway-note", icon: "shield", iconSize: 18 }, [h("span", null, [
        h("b", { text: method === "Card" ? "Card payment via secure gateway. " : "Mobile wallet payment via secure gateway. " }),
        "The customer pays on the terminal or their phone. Card and wallet details never touch this system and are never stored (SR-8)."
      ])]);
    }

    const payBtn = h("button", { class: "btn btn-primary btn-lg btn-block", id: "payBtn", icon: "check-circle", iconSize: 18,
      text: "Charge " + CMS.money(t.total), onclick: function () { pay(tab, t); } });
    if (!tab.allServed) payBtn.disabled = true;

    body.append(
      lines,
      h("div", { class: "bill-section" }, [h("div", { class: "label" }, ["Discount ", h("span", { class: "opt", text: "Your limit: " + limit + "%" })]), discRow]),
      h("div", { class: "ticket-totals" }, [
        h("div", null, [h("span", { class: "muted", text: "Subtotal" }), h("span", { text: CMS.money(t.sub) })]),
        discount ? h("div", { class: "disc" }, [h("span", { text: "Discount (" + discount + "%)" }), h("span", { text: "− " + CMS.money(t.discount) })]) : null,
        h("div", null, [h("span", { class: "muted", text: "Tax (16%)" }), h("span", { text: CMS.money(t.tax) })]),
        h("div", { class: "grand" }, [h("span", { text: "Total due" }), h("span", { text: CMS.money(t.total) })])
      ]),
      h("div", { class: "bill-section" }, [h("div", { class: "label", text: "Payment method" }), methodRow, payExtra]),
      h("div", { class: "bill-section" }, [
        !tab.allServed ? h("div", { class: "alert alert-warn show", icon: "alert", iconSize: 18 }, [h("span", { text: "Some orders on this table haven't been served yet, so it can't be billed." })]) : null,
        payBtn
      ])
    );
  }

  async function pay(tab, t) {
    const ok = await CMS.confirm({ title: "Charge " + CMS.money(t.total) + "?", message: "Table " + tab.no + " · " + (method === "Wallet" ? "Mobile wallet" : method) + (discount ? " · " + discount + "% discount" : "") + ". This records the payment and frees the table.", okText: "Record payment", icon: "receipt" });
    if (!ok) return;
    const btn = document.getElementById("payBtn");
    if (btn) { btn.disabled = true; btn.textContent = method === "Cash" ? "Recording…" : "Waiting for gateway…"; }
    setTimeout(function () {
      const bill = CMS.attempt(function () { return Store.pay(tab.no, { discountPct: discount, method: method, tendered: tendered }, me); });
      if (!bill) { renderBill(); return; }
      selected = null; discount = 0; tendered = ""; history.replaceState(null, "", location.pathname);
      CMS.toast("Payment recorded · " + bill.no, "ok");
      showReceipt(bill);
    }, method === "Cash" ? 300 : 1200);
  }

  // ----- Receipt -----
  function showReceipt(b) {
    const r = document.getElementById("receipt");
    const cashier = Store.findUser(b.cashier);
    r.innerHTML = "";
    const add = function () { Array.prototype.forEach.call(arguments, function (n) { if (n) r.appendChild(n); }); };
    const row = function (a, c, cls) { return h("div", { class: "r-row " + (cls || "") }, [h("span", { text: a }), h("span", { text: c })]); };
    add(
      h("div", { class: "r-head" }, [h("div", { class: "r-logo" }, [App.I("coffee", 22)]), h("b", { text: "CafeMS" }), h("small", { text: "Cafe Management System" }), h("small", { text: "NTN 0000000-0 · GST registered" })]),
      h("div", { class: "r-sep" }),
      row("Receipt", b.no), row("Date", CMS.dateTime(b.createdAt)), row("Table", String(b.table)), row("Cashier", cashier ? cashier.name : b.cashier),
      h("div", { class: "r-sep" }),
      h("div", null, b.lines.map(function (l) { return h("div", { class: "r-line" }, [h("span", { text: l.qty + " × " + l.name }), h("span", { text: CMS.money(l.price * l.qty) })]); })),
      h("div", { class: "r-sep" }),
      row("Subtotal", CMS.money(b.subtotal)),
      b.discount ? row("Discount (" + b.discountPct + "%)", "− " + CMS.money(b.discount)) : null,
      row("GST 16%", CMS.money(b.tax)),
      row("TOTAL", CMS.money(b.total), "r-total"),
      h("div", { class: "r-sep" }),
      row("Paid by", b.method === "Wallet" ? "Mobile wallet" : b.method),
      b.method === "Cash" ? row("Cash received", CMS.money(b.tendered)) : null,
      b.method === "Cash" ? row("Change", CMS.money(b.change || 0)) : row("Card / wallet no.", "Not stored"),
      b.status === "Refunded" ? h("div", { class: "r-refunded", text: "REFUNDED · " + (b.refund ? b.refund.reason : "") }) : null,
      h("div", { class: "r-sep" }),
      h("p", { class: "r-foot", text: "Thank you for visiting! Keep this receipt for returns within 24 hours." })
    );
    CMS.openModal("receiptModal");
  }

  // ----- Today's bills -----
  function renderBills() {
    const bills = Store.bills().filter(function (b) { return new Date(b.createdAt).toDateString() === new Date().toDateString(); });
    const rows = bills.filter(function (b) { return !query || b.no.toLowerCase().indexOf(query) !== -1 || ("t" + b.table) === query || String(b.table) === query; });
    document.getElementById("recentSub").textContent = bills.length + " bills today" + (role === "Cashier" ? " · refunds need a manager" : "");
    const body = document.getElementById("billsBody");
    body.innerHTML = "";
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [h("div", { class: "empty-state", style: "padding:24px", text: "No bills match." })])])); return; }
    rows.forEach(function (b) {
      const actions = h("div", { class: "row-actions" }, [h("button", { class: "btn btn-ghost btn-sm", text: "Receipt", "aria-label": "Show receipt " + b.no, onclick: function () { showReceipt(b); } })]);
      if (role === "Manager" && b.status === "Paid") actions.appendChild(h("a", { class: "btn btn-ghost btn-sm", href: "reports.html#refund-" + b.no, text: "Refund" }));
      body.appendChild(h("tr", null, [
        h("td", null, [h("span", { class: "mono", text: b.no })]), h("td", { text: "T" + b.table }),
        h("td", { class: "hide-sm time", text: CMS.clock(new Date(b.createdAt)) }), h("td", { class: "hide-sm", text: b.method === "Wallet" ? "Wallet" : b.method }),
        h("td", { class: "num nowrap", text: CMS.money(b.total) }),
        h("td", null, [h("span", { class: "pill " + (b.status === "Paid" ? "pill-ready" : "pill-cancelled"), text: b.status })]),
        h("td", { class: "actions" }, [actions])
      ]));
    });
  }
})();
