// Billing: open tables and counter orders → bill with role-limited discount → payment → receipt.
// A bill can be paid in parts (split evenly, by items, or any amount, each part by any method), with an
// optional tip. Card and wallet payments go through the (simulated) gateway; card details are never
// entered or stored here (SR-8). Every amount is worked out again by the server. Refunds are
// manager-only (SR-3, SR-7).
(function () {
  if (!window.App) return;
  const h = CMS.h, role = App.session.role;
  const DISCOUNTS = [0, 5, 10, 15, 20, 25];
  const TIPS = [0, 5, 10, 15];
  let selected = null, discount = 0, method = "Cash", tendered = "", phone = "", query = "", billSignature = "";
  // How much to pay now: the rest, an equal share, chosen items, or a typed amount
  let mode = "full", splitN = 2, customAmount = "", picks = {}, tipPct = 0, tipCustom = "";

  function resetPayment() { discount = 0; tendered = ""; phone = ""; mode = "full"; splitN = 2; customAmount = ""; picks = {}; tipPct = 0; tipCustom = ""; }

  App.ready(function () {
    const m = /^#(t\d+|ORD-\d+)$/.exec(location.hash);
    if (m) selected = m[1];
    if (role === "Cashier") {
      // Billing is the cashier's home page, so greet them by name
      const hour = new Date().getHours();
      document.getElementById("billHeading").textContent = (hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening") + ", " + App.session.name.split(" ")[0];
    }
    renderAll();
    Store.on(renderAll);
    document.getElementById("billSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); renderBills(); });
    document.getElementById("printReceipt").addEventListener("click", function () { CMS.printArea("receipt"); });
  });

  function renderAll() { renderStats(); renderTables(); refreshBill(); renderBills(); }

  // A refresh must not disturb a cashier who is typing: the bill is redrawn only if it really changed,
  // and then the field they were in keeps the focus
  function refreshBill() {
    const tab = selected ? Store.openTables().find(function (t) { return t.key === selected; }) : null;
    if (JSON.stringify(tab || null) === billSignature) return;
    const active = document.activeElement;
    const focusedId = active && active.id && active.closest("#billBody") ? active.id : null;
    renderBill();
    const again = focusedId && document.getElementById(focusedId);
    if (again) again.focus();
  }

  function renderStats() {
    const paid = Store.bills().filter(function (b) { return b.status === "Paid"; }), open = Store.openTables();
    const s = { revenue: paid.reduce(function (sum, b) { return sum + b.total; }, 0), bills: paid.length };
    const box = document.getElementById("billStats");
    box.replaceChildren();
    [["Collected today", CMS.money(s.revenue)], ["Bills", String(s.bills)], ["Open orders", String(open.length)]].forEach(function (x) {
      box.appendChild(h("div", { class: "stat-chip" }, [h("small", { text: x[0] }), h("b", { text: x[1] })]));
    });
  }

  // ----- Open tables and counter orders -----
  function renderTables() {
    const wrap = document.getElementById("openTables");
    const open = Store.openTables().sort(function (a, b) { return (b.check ? 1 : 0) - (a.check ? 1 : 0) || (b.billRequested ? 1 : 0) - (a.billRequested ? 1 : 0) || a.since - b.since; });
    if (selected && !open.some(function (t) { return t.key === selected; })) selected = null;
    wrap.replaceChildren();
    if (!open.length) {
      wrap.appendChild(h("div", { class: "empty-state", icon: "receipt", iconSize: 32 }, [h("b", { text: "Nothing to bill" }), h("span", { text: "Tables and counter orders appear here as soon as they are sent." })]));
      return;
    }
    open.forEach(function (t) {
      const state = t.check ? ["Part paid", "pill-bill"] : t.billRequested ? ["Bill requested", "pill-bill"] : t.allServed ? ["Ready to bill", "pill-ready"] : [t.type === "dine-in" ? "Still being served" : "Being prepared", "pill-preparing"];
      wrap.appendChild(h("button", { type: "button", class: "table-card" + (selected === t.key ? " selected" : "") + (t.billRequested || t.check ? " attention" : ""), "aria-pressed": String(selected === t.key),
        onclick: function () { selected = t.key; resetPayment(); history.replaceState(null, "", "#" + t.key); renderTables(); renderBill();
          if (window.innerWidth <= 1100) document.getElementById("billPanel").scrollIntoView({ behavior: "smooth", block: "start" }); } }, [
        h("div", { class: "tc-top" }, [h("span", { class: "tc-no", text: t.no ? "T" + t.no : t.label }), h("span", { class: "pill " + state[1], text: state[0] })]),
        h("div", { class: "tc-total", text: t.check ? CMS.money(t.check.remaining) + " left" : CMS.money(t.totals.total) }),
        h("div", { class: "tc-meta", text: t.totals.count + " items · " + t.orders.length + " order" + (t.orders.length === 1 ? "" : "s") + " · " + t.waiters.join(", ") }),
        h("div", { class: "tc-meta", text: t.check ? "Paid " + CMS.money(t.check.paid) + " in " + t.check.parts + " part" + (t.check.parts === 1 ? "" : "s") : (t.no ? "Seated " : "Ordered ") + CMS.timeAgo(t.since) })
      ]));
    });
  }

  // What the whole bill comes to: the stored check once payment has started, otherwise worked out here
  // for display (the server does the same sum when the first payment is made)
  function billTotals(tab) {
    if (tab.check) {
      const c = tab.check;
      return { sub: c.subtotal, discount: c.discount, service: c.service, tax: c.tax, total: c.total, remaining: c.remaining, discountPct: c.discountPct };
    }
    const t = Store.totals(tab.lines, discount, tab.type === "dine-in");
    return { sub: t.sub, discount: t.discount, service: t.service, tax: t.tax, total: t.total, remaining: t.total, discountPct: discount };
  }

  function amountNow(tab, b) {
    if (mode === "split") return Math.min(b.remaining, Math.ceil(b.remaining / splitN));
    if (mode === "items") {
      const sel = tab.lines.reduce(function (s, l, i) { return s + l.price * (picks[i] || 0); }, 0);
      return Math.min(b.remaining, Math.round(b.total * sel / (b.sub || 1)));
    }
    if (mode === "custom") return Math.min(b.remaining, Math.max(0, Math.floor(Number(customAmount) || 0)));
    return b.remaining;
  }
  function tipNow(amount) { return tipPct === "custom" ? Math.max(0, Math.floor(Number(tipCustom) || 0)) : Math.round(amount * tipPct / 100); }

  // ----- Bill panel -----
  function renderBill() {
    const body = document.getElementById("billBody");
    const tab = selected ? Store.openTables().find(function (t) { return t.key === selected; }) : null;
    billSignature = JSON.stringify(tab || null);
    body.replaceChildren();
    document.getElementById("billState").textContent = "";
    if (!tab) {
      document.getElementById("billTitle").textContent = "Bill";
      document.getElementById("billSub").textContent = "Select a table or order to start";
      body.appendChild(h("div", { class: "empty-state", icon: "clipboard", iconSize: 36 }, [h("b", { text: "Nothing selected" }), h("span", { text: "Choose an open table or counter order on the left to prepare its bill." })]));
      return;
    }
    const limit = Store.discountLimit;
    const b = billTotals(tab);
    const amount = amountNow(tab, b);
    const tip = tipNow(amount);
    const charge = amount + tip;
    document.getElementById("billTitle").textContent = tab.label;
    document.getElementById("billSub").textContent = tab.orders.map(function (o) { return o.id; }).join(", ") + " · " + tab.waiters.join(", ");
    document.getElementById("billState").textContent = tab.totals.count + " items";

    const lines = h("ul", { class: "bill-lines" }, tab.lines.map(function (l, i) {
      const pick = mode === "items" ? h("span", { class: "stepper sm" }, [
        h("button", { type: "button", "aria-label": "One less " + l.name, onclick: function () { picks[i] = Math.max(0, (picks[i] || 0) - 1); renderBill(); } }, [App.I("minus", 13)]),
        h("span", { text: String(picks[i] || 0) }),
        h("button", { type: "button", "aria-label": "One more " + l.name, onclick: function () { picks[i] = Math.min(l.qty, (picks[i] || 0) + 1); renderBill(); } }, [App.I("plus", 13)])
      ]) : h("span", { class: "q", text: l.qty + "×" });
      return h("li", { class: mode === "items" ? "picking" : "" }, [pick, h("span", { class: "n" }, [(mode === "items" ? l.qty + "× " : "") + l.name, l.options && l.options.length ? h("small", { class: "sub-line", text: l.options.join(", ") }) : null]), h("span", { class: "a", text: CMS.money(l.price * l.qty) })]);
    }));

    // Discount (role-limited). Once a part has been paid it is fixed for the whole bill.
    const discRow = tab.check
      ? h("p", { class: "muted small", text: tab.check.discountPct ? "Discount of " + tab.check.discountPct + "% was set with the first payment." : "No discount: payment has already started." })
      : h("div", { class: "seg", role: "radiogroup", "aria-label": "Discount" }, DISCOUNTS.map(function (d) {
        const over = d > limit;
        return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(d === discount), disabled: over ? true : null,
          title: over ? "Needs manager approval" : null, text: d ? d + "%" : "None", onclick: function () { discount = d; renderBill(); } });
      }));

    // How much to pay now
    const modes = [["full", "Pay all"], ["split", "Split evenly"], ["items", "By items"], ["custom", "Amount"]];
    const modeRow = h("div", { class: "seg", role: "radiogroup", "aria-label": "How much to pay now" }, modes.map(function (m) {
      return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(m[0] === mode), text: m[1], onclick: function () { mode = m[0]; renderBill(); } });
    }));
    let modeExtra = null;
    if (mode === "split") {
      modeExtra = h("div", { class: "quick" }, [2, 3, 4, 5, 6].map(function (n) {
        return h("button", { type: "button", class: "chip-btn" + (n === splitN ? " on" : ""), "aria-pressed": String(n === splitN), text: n + " people", onclick: function () { splitN = n; renderBill(); } });
      }).concat([h("span", { class: "muted small", text: "Each pays " + CMS.money(Math.ceil(b.remaining / splitN)) + "; the last pays what is left." })]));
    } else if (mode === "items") {
      modeExtra = h("p", { class: "muted small", text: "Choose what this person had. Their share of tax" + (b.service ? ", service" : "") + (b.discount ? " and discount" : "") + " is added." });
    } else if (mode === "custom") {
      const input = h("input", { class: "input", id: "partAmount", type: "number", min: "1", max: String(b.remaining), inputmode: "numeric", value: customAmount, placeholder: String(b.remaining), "aria-label": "Amount to pay now" });
      input.addEventListener("change", function () { customAmount = input.value; renderBill(); });
      modeExtra = h("div", { class: "input-group" }, [h("span", { class: "addon", text: "Rs" }), input]);
    }

    // Tip, which goes to the staff and is not counted as sales
    const tipRow = h("div", { class: "seg", role: "radiogroup", "aria-label": "Tip" }, TIPS.map(function (p) {
      return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(tipPct === p), text: p ? p + "%" : "No tip", onclick: function () { tipPct = p; renderBill(); } });
    }).concat([h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(tipPct === "custom"), text: "Other", onclick: function () { tipPct = "custom"; renderBill(); } })]));
    const tipInput = tipPct === "custom" ? h("div", { class: "input-group" }, [h("span", { class: "addon", text: "Rs" }), (function () {
      const i = h("input", { class: "input", id: "tipAmount", type: "number", min: "0", inputmode: "numeric", value: tipCustom, "aria-label": "Tip amount" });
      i.addEventListener("change", function () { tipCustom = i.value; renderBill(); });
      return i;
    })()]) : null;

    // Payment method
    const methods = [["Cash", "cash"], ["Card", "card"], ["Wallet", "wallet"]];
    const methodRow = h("div", { class: "seg", role: "radiogroup", "aria-label": "Payment method" }, methods.map(function (m) {
      return h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(m[0] === method), icon: m[1], iconSize: 15, text: m[0] === "Wallet" ? "Mobile wallet" : m[0],
        onclick: function () { method = m[0]; renderBill(); } });
    }));

    const canPay = tab.allServed && amount >= 1;
    const payBtn = h("button", { class: "btn btn-primary btn-lg btn-block", id: "payBtn", icon: "check-circle", iconSize: 18,
      text: "Charge " + CMS.money(charge) + (amount < b.remaining ? " · part" : ""), onclick: function () { pay(tab, amount, tip); } });
    payBtn.disabled = !canPay;

    let payExtra;
    if (method === "Cash") {
      const input = h("input", { class: "input", id: "tendered", type: "number", min: String(charge), step: "10", inputmode: "numeric", value: tendered, placeholder: String(charge), "aria-label": "Cash received" });
      const change = h("div", { class: "change", id: "changeBox" });
      const updateChange = function () {
        tendered = input.value;
        const v = Number(input.value);
        change.textContent = input.value === "" ? "Enter the cash received" : v >= charge ? "Change due: " + CMS.money(v - charge) : "Short by " + CMS.money(charge - v);
        change.className = "change " + (input.value === "" ? "" : v >= charge ? "ok" : "bad");
        payBtn.disabled = !(v >= charge) || !canPay;
      };
      input.addEventListener("input", updateChange);
      const quick = [charge, Math.ceil(charge / 500) * 500, Math.ceil(charge / 1000) * 1000, Math.ceil(charge / 5000) * 5000]
        .filter(function (v, i, a) { return v > 0 && a.indexOf(v) === i; }).slice(0, 4);
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
        "The customer pays on the terminal or their phone. Card and wallet details never touch this system and are never stored."
      ])]);
    }

    // Optional customer mobile for the digital receipt (personal data: masked for cashiers once saved)
    const phoneInput = h("input", { class: "input", id: "custPhone", type: "tel", inputmode: "numeric", maxlength: "13", value: phone, placeholder: "03XXXXXXXXX", autocomplete: "off",
      oninput: function (e) { phone = e.target.value; } });
    const rate = Math.round(Store.taxRate * 1000) / 10;
    const service = Math.round((Store.serviceRate || 0) * 1000) / 10;

    body.append(
      lines,
      h("div", { class: "bill-section" }, [h("div", { class: "label" }, ["Discount ", h("span", { class: "opt", text: "Your limit: " + limit + "%" })]), discRow]),
      h("div", { class: "ticket-totals" }, [
        h("div", null, [h("span", { class: "muted", text: "Subtotal" }), h("span", { text: CMS.money(b.sub) })]),
        b.discount ? h("div", { class: "disc" }, [h("span", { text: "Discount (" + b.discountPct + "%)" }), h("span", { text: "− " + CMS.money(b.discount) })]) : null,
        b.service ? h("div", null, [h("span", { class: "muted", text: "Service charge (" + service + "%)" }), h("span", { text: CMS.money(b.service) })]) : null,
        h("div", null, [h("span", { class: "muted", text: "Tax (" + rate + "%)" }), h("span", { text: CMS.money(b.tax) })]),
        h("div", { class: "grand" }, [h("span", { text: "Bill total" }), h("span", { text: CMS.money(b.total) })]),
        tab.check ? h("div", { class: "disc" }, [h("span", { text: "Already paid (" + tab.check.parts + " part" + (tab.check.parts === 1 ? "" : "s") + ")" }), h("span", { text: "− " + CMS.money(tab.check.paid) })]) : null,
        tab.check ? h("div", { class: "grand" }, [h("span", { text: "Left to pay" }), h("span", { text: CMS.money(b.remaining) })]) : null
      ]),
      h("div", { class: "bill-section" }, [h("div", { class: "label", text: "Pay now" }), modeRow, modeExtra,
        h("div", { class: "pay-now" }, [h("span", { text: "This payment" }), h("b", { text: CMS.money(amount) + (tip ? " + " + CMS.money(tip) + " tip" : "") })])]),
      h("div", { class: "bill-section" }, [h("div", { class: "label" }, ["Tip ", h("span", { class: "opt", text: "Optional · goes to the staff" })]), tipRow, tipInput]),
      h("div", { class: "bill-section" }, [h("div", { class: "label", text: "Payment method" }), methodRow, payExtra]),
      h("div", { class: "bill-section" }, [h("label", { class: "label", for: "custPhone" }, ["Customer mobile ", h("span", { class: "opt", text: "Optional · for e-receipt" })]), phoneInput]),
      h("div", { class: "bill-section" }, [
        !tab.allServed ? h("div", { class: "alert alert-warn show", icon: "alert", iconSize: 18 }, [h("span", { text: tab.no ? "Some orders on this table haven't been served yet, so it can't be billed." : "This order is still being prepared. Hand it over when it is ready, then take payment." })]) : null,
        handOver(tab),
        voidButtons(tab),
        payBtn
      ])
    );
  }

  // A counter order this person took is handed over here once every station has it ready
  function handOver(tab) {
    if (tab.no) return null;
    const mine = Store.order(tab.orderId);
    if (!mine || mine.status !== "Ready") return null;
    return h("button", { class: "btn btn-success btn-block", icon: "check", text: "Hand over " + tab.orderId, onclick: function (e) {
      CMS.busy(e.currentTarget, async function () { if (await CMS.attempt(function () { return Store.serve(tab.orderId); })) CMS.toast(tab.orderId + " handed over", "ok"); });
    } });
  }

  // A manager can void an order on this tab, with a reason and a fresh authenticator code
  function voidButtons(tab) {
    if (role !== "Manager" || tab.check) return null;
    return h("div", { class: "void-row" }, tab.orders.map(function (o) {
      return h("button", { type: "button", class: "btn btn-ghost btn-sm", icon: "x", text: "Void " + o.id, onclick: function () { askVoid(o.id); } });
    }));
  }
  function askVoid(id) {
    const reason = h("input", { class: "input", maxlength: "80", placeholder: "For example: customer left, wrong item", "aria-label": "Reason", "data-autofocus": true });
    const err = h("div", { class: "alert alert-error", role: "alert" });
    const ok = h("button", { class: "btn btn-danger", text: "Void order" });
    let modal = document.getElementById("voidModal");
    if (modal) modal.remove();
    modal = h("div", { class: "modal-backdrop", id: "voidModal", role: "dialog", "aria-modal": "true", "aria-labelledby": "voidTitle" }, [
      h("div", { class: "modal" }, [
        h("div", { class: "modal-head" }, [h("div", { class: "icon-tile danger" }, [App.I("x", 20)]), h("div", null, [h("h3", { id: "voidTitle", text: "Void " + id + "?" }), h("p", { text: "It leaves the bill. Food a station has started is counted as used. This is recorded in the audit log." })])]),
        h("div", { class: "modal-body" }, [err, h("div", { class: "field" }, [h("label", { class: "label", text: "Reason" }), reason])]),
        h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-secondary", "data-close": "voidModal", text: "Keep it" }), ok])
      ])
    ]);
    document.body.appendChild(modal);
    ok.addEventListener("click", function () {
      CMS.clearError(err);
      CMS.busy(ok, async function () {
        const done = await CMS.attempt(function () { return CMS.withStepUp(function () { return Store.voidOrder(id, reason.value.trim()); }); }, err);
        if (done) { CMS.closeModal("voidModal"); CMS.toast(id + " voided", "ok"); }
      });
    });
    CMS.openModal("voidModal");
  }

  async function pay(tab, amount, tip) {
    const b = billTotals(tab);
    const part = amount < b.remaining;
    const ok = await CMS.confirm({
      title: "Charge " + CMS.money(amount + tip) + "?",
      message: tab.label + " · " + (method === "Wallet" ? "Mobile wallet" : method) + (tip ? " · includes " + CMS.money(tip) + " tip" : "") +
        (part ? ". " + CMS.money(b.remaining - amount) + " will be left to pay." : (tab.no ? ". This settles the bill and frees the table." : ". This settles the bill.")),
      okText: "Record payment", icon: "receipt"
    });
    if (!ok) return;
    const btn = document.getElementById("payBtn");
    if (btn) { btn.disabled = true; btn.textContent = method === "Cash" ? "Recording…" : "Waiting for gateway…"; }
    const opts = { discountPct: tab.check ? 0 : discount, method: method, tendered: tendered, phone: phone, tip: tip };
    if (part) opts.amount = amount;
    const bill = await CMS.attempt(function () { return Store.pay(tab, opts); });
    if (!bill) { renderBill(); return; }
    const done = !bill.check || bill.check.remaining === 0;
    tendered = ""; phone = ""; tipPct = 0; tipCustom = ""; customAmount = ""; picks = {};
    if (done) { selected = null; resetPayment(); history.replaceState(null, "", location.pathname); }
    // One person in an even split has paid: the rest is shared by those left
    else if (mode === "split") { splitN -= 1; if (splitN < 2) mode = "full"; }
    renderAll();
    if (bill.status !== "Paid") {
      CMS.toast(bill.status === "Payment Failed" ? bill.no + " was declined. Try again or take another payment method." : "The gateway did not answer, so " + bill.no + " is pending. You can retry it below.", "err");
      return;
    }
    CMS.toast("Payment recorded · " + bill.no + (done ? "" : " · " + CMS.money(bill.check.remaining) + " left"), "ok");
    showReceipt(bill);
  }

  // ----- Receipt (80 mm) -----
  function showReceipt(b) {
    const r = document.getElementById("receipt");
    r.replaceChildren();
    const add = function () { Array.prototype.forEach.call(arguments, function (n) { if (n) r.appendChild(n); }); };
    const row = function (a, c, cls) { return h("div", { class: "r-row " + (cls || "") }, [h("span", { text: a }), h("span", { text: c })]); };
    const split = b.share !== undefined && b.share < 1;
    add(
      h("div", { class: "r-head" }, [h("div", { class: "r-logo" }, [App.I("coffee", 22)]), h("b", { text: Store.cafe().name }), Store.cafe().address ? h("small", { text: Store.cafe().address }) : null, Store.cafe().phone ? h("small", { text: Store.cafe().phone }) : null, Store.receipt().header ? h("small", { text: Store.receipt().header }) : null]),
      h("div", { class: "r-sep" }),
      row("Receipt", b.no), row("Date", CMS.dateTime(b.createdAt)), row(b.type === "dine-in" ? "Table" : "Order", b.type === "dine-in" ? String(b.table) : b.label), row("Cashier", Store.staffName(b.cashier)),
      split ? row("Split bill", "Part " + b.part + " · " + (b.checkId || "")) : null,
      b.phone ? row("Customer", b.phone) : null,
      h("div", { class: "r-sep" }),
      h("div", null, b.lines.map(function (l) { return h("div", { class: "r-line" }, [h("span", { text: l.qty + " × " + l.name + (l.options && l.options.length ? " (" + l.options.join(", ") + ")" : "") }), h("span", { text: CMS.money(l.price * l.qty) })]); })),
      h("div", { class: "r-sep" }),
      split ? h("p", { class: "r-note", text: "Your share of the bill:" }) : null,
      row("Subtotal", CMS.money(b.subtotal)),
      b.discount ? row("Discount (" + b.discountPct + "%)", "− " + CMS.money(b.discount)) : null,
      b.service ? row("Service charge", CMS.money(b.service)) : null,
      row("Tax", CMS.money(b.tax)),
      row(split ? "THIS PART" : "TOTAL", CMS.money(b.total), "r-total"),
      b.tip ? row("Tip", CMS.money(b.tip)) : null,
      b.tip ? row("PAID", CMS.money(b.charge), "r-total") : null,
      h("div", { class: "r-sep" }),
      row("Paid by", b.method === "Wallet" ? "Mobile wallet" : b.method),
      b.method === "Cash" ? row("Cash received", CMS.money(b.tendered)) : null,
      b.method === "Cash" ? row("Change", CMS.money(b.change || 0)) : row("Card / wallet no.", "Not stored"),
      b.status === "Refunded" ? h("div", { class: "r-refunded", text: "REFUNDED · " + (b.refund ? b.refund.reason : "") }) : null,
      h("div", { class: "r-sep" }),
      h("p", { class: "r-foot", text: Store.receipt().footer || "Thank you for visiting!" })
    );
    CMS.openModal("receiptModal");
  }

  // ----- Today's bills -----
  function renderBills() {
    const bills = Store.bills();
    const rows = bills.filter(function (b) { return !query || b.no.toLowerCase().indexOf(query) !== -1 || ("t" + b.table) === query || String(b.table) === query; });
    document.getElementById("recentSub").textContent = bills.length + " bills today" + (role === "Cashier" ? " · refunds need a manager · customer numbers are masked" : "");
    const body = document.getElementById("billsBody");
    body.replaceChildren();
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "8" }, [h("div", { class: "empty-state pad-24", text: "No bills match." })])])); return; }
    rows.forEach(function (b) {
      const actions = h("div", { class: "row-actions" });
      if (b.status === "Paid" || b.status === "Refunded") actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Receipt", "aria-label": "Show receipt " + b.no, onclick: function () { showReceipt(b); } }));
      if (b.phone && role === "Manager") actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Number", "aria-label": "Show customer number for " + b.no, onclick: function () { CMS.showPhone(function () { return Store.billPhone(b.no); }); } }));
      if (b.status === "Pending Payment" || b.status === "Payment Failed") actions.appendChild(h("button", { class: "btn btn-secondary btn-sm", text: "Retry", "aria-label": "Retry payment for " + b.no, onclick: function (e) { retry(b, e.currentTarget); } }));
      if (b.status === "Payment Failed") actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Take cash", "aria-label": "Take cash for " + b.no, onclick: function (e) { takeCash(b, e.currentTarget); } }));
      if (b.status === "Paid" && !b.refundPending) actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Refund", "aria-label": "Refund " + b.no, onclick: function () { requestRefund(b); } }));
      body.appendChild(h("tr", null, [
        h("td", null, [h("span", { class: "mono", text: b.no })]), h("td", { text: b.type === "dine-in" ? "T" + b.table : b.label }),
        h("td", { class: "hide-sm time", text: CMS.clock(new Date(b.createdAt)) }), h("td", { class: "hide-sm", text: b.method === "Wallet" ? "Wallet" : b.method }),
        h("td", { class: "hide-sm mono", text: b.phone || "—" }),
        h("td", { class: "num nowrap", text: CMS.money(b.total) }),
        h("td", null, [h("span", { class: "pill " + (b.status === "Paid" ? "pill-ready" : b.status === "Pending Payment" ? "pill-preparing" : "pill-cancelled"), text: b.status })]),
        h("td", { class: "actions" }, [actions])
      ]));
    });
  }

  // A declined card or wallet payment can be settled in cash for the exact amount instead
  async function takeCash(b, button) {
    const ok = await CMS.confirm({ title: "Take " + CMS.money(b.charge) + " in cash?", message: b.no + " will be marked paid in cash for the exact amount.", okText: "Record cash", icon: "cash" });
    if (!ok) return;
    await CMS.busy(button, async function () {
      const bill = await CMS.attempt(function () { return Store.retryPayment(b.no, { method: "Cash", tendered: b.charge }); });
      if (bill) CMS.toast(b.no + " paid in cash", "ok");
    });
  }

  async function retry(b, button) {
    await CMS.busy(button, async function () {
      const bill = await CMS.attempt(function () { return Store.retryPayment(b.no); });
      if (bill) CMS.toast(bill.status === "Paid" ? b.no + " paid" : b.no + " is still not paid: " + bill.status.toLowerCase(), bill.status === "Paid" ? "ok" : "err");
    });
  }

  // ----- Refund: manager-only function (SR-3) -----
  // The server decides and logs the attempt, so changing this script would not let a cashier refund.
  async function requestRefund(b) {
    if (role === "Manager") { location.href = "reports.html#refund-" + b.no; return; }
    try { await Store.refund(b.no, "Attempted from billing"); } catch (e) { /* denied and logged by the server */ }
    CMS.confirm({ title: "Access denied", message: "Only a manager can issue refunds. Your attempt on " + b.no + " has been recorded in the audit log. Ask the manager on duty to process it.",
      okText: "OK", cancelText: "Close", icon: "shield", danger: true });
  }
})();
