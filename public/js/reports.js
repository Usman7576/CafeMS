// Sales reports (Manager/Admin): KPIs, revenue by hour, payment split, best
// sellers, category sales, tax summary, bills with refunds, CSV export, print.
(function () {
  if (!window.App) return;
  const h = CMS.h, canRefund = App.session.role === "Manager";
  const COLORS = { Cash: "#3d2518", Card: "#c47a2c", Wallet: "#1d7a4b" };
  let refundNo = null, pickedDate = null, pickedSales = null, pickedBills = [];
  const salesData = function () { return pickedDate ? pickedSales : Store.salesToday(); };
  const billsData = function () { return pickedDate ? pickedBills : Store.bills(); };
  const todayValue = function () { const n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); };

  async function pickDate(value) {
    if (!value || value === todayValue()) {
      pickedDate = null;
    } else {
      const loaded = await CMS.attempt(async function () { return [await Store.salesFor(value), await Store.billsFor(value)]; });
      if (!loaded) return;
      pickedDate = value; pickedSales = loaded[0]; pickedBills = loaded[1];
    }
    document.getElementById("reportDate").textContent = (pickedDate ? CMS.dateLong(new Date(pickedDate + "T12:00:00")) : CMS.dateLong(new Date())) + " · all figures in PKR";
    document.getElementById("billsTitle").textContent = pickedDate ? "Bills on this day" : "Bills today";
    render();
  }

  async function renderTrend() {
    const days = await CMS.attempt(function () { return Store.trend(); });
    if (!days) return;
    CMS.barChart(document.getElementById("trendChart"), days.map(function (d) {
      return { label: d.date.slice(5), value: d.revenue, highlight: d.date === todayValue(), title: d.date + " · " + CMS.money(d.revenue) + " · " + d.bills + " bills" };
    }), { height: 200, label: "Paid revenue for the last 7 days" });
  }

  App.ready(function () {
    document.getElementById("reportDate").textContent = CMS.dateLong(new Date()) + " · all figures in PKR";
    document.getElementById("exportCsv").addEventListener("click", exportCsv);
    const pick = document.getElementById("reportPick");
    pick.max = todayValue();
    pick.value = todayValue();
    pick.addEventListener("change", function () { pickDate(pick.value); });
    renderTrend();
    document.getElementById("printReport").addEventListener("click", function () { window.print(); });
    document.getElementById("refundForm").addEventListener("submit", doRefund);
    render();
    Store.on(render);
    const m = /^#refund-(B-\d+)$/.exec(location.hash);
    if (m) openRefund(m[1]);
  });

  function render() {
    const s = salesData();
    document.getElementById("rRevenue").textContent = CMS.money(s.revenue);
    document.getElementById("rBills").textContent = s.bills;
    document.getElementById("rAvg").textContent = CMS.money(s.avg);
    document.getElementById("rItems").textContent = s.items;
    document.getElementById("rDisc").textContent = CMS.money(s.discounts);
    document.getElementById("rRefund").textContent = CMS.money(s.refundAmount);
    document.getElementById("rRefundSub").textContent = s.refunds + " bill" + (s.refunds === 1 ? "" : "s") + " refunded";

    const nowH = new Date().getHours();
    let first = s.byHour.findIndex(function (v) { return v > 0; });
    first = first === -1 ? 8 : Math.min(first, 8);
    const data = [];
    for (let i = first; i <= Math.max(nowH, first + 5); i++) {
      data.push({ label: (i % 12 || 12) + (i < 12 ? "a" : "p"), value: s.byHour[i] || 0, highlight: i === nowH, title: (i % 12 || 12) + ":00 " + (i < 12 ? "AM" : "PM") + " · " + CMS.money(s.byHour[i] || 0) });
    }
    CMS.barChart(document.getElementById("hourChart"), data, { height: 240, label: "Revenue by hour" });
    CMS.donut(document.getElementById("methodChart"), Object.keys(COLORS).map(function (k) { return { label: k === "Wallet" ? "Mobile wallet" : k, value: s.byMethod[k] || 0, color: COLORS[k] }; }), CMS.compact(s.revenue));
    CMS.hBars(document.getElementById("topItems"), s.top.map(function (t) { return { label: t.name, value: t.qty, display: t.qty + " sold", sub: CMS.money(t.revenue) + " revenue" }; }));
    CMS.hBars(document.getElementById("catChart"), Object.keys(s.byCat).sort(function (a, b) { return s.byCat[b] - s.byCat[a]; }).map(function (c) { return { label: c, value: s.byCat[c], display: CMS.money(s.byCat[c]) }; }));

    const tax = document.getElementById("taxSummary");
    tax.replaceChildren();
    const gross = s.revenue - s.tax + s.discounts;
    [["Gross sales", CMS.money(gross)], ["Discounts", "− " + CMS.money(s.discounts)], ["Net sales (before tax)", CMS.money(gross - s.discounts)], ["GST collected (16%)", CMS.money(s.tax)]].forEach(function (r) {
      tax.appendChild(h("div", { class: "row" }, [h("span", { class: "muted", text: r[0] }), h("span", { text: r[1] })]));
    });
    tax.appendChild(h("div", { class: "row total" }, [h("span", { text: "Total collected" }), h("span", { text: CMS.money(s.revenue) })]));

    renderBills();
  }

  function renderBills() {
    const body = document.getElementById("billsBody");
    body.replaceChildren();
    const bills = billsData();
    if (!bills.length) { body.appendChild(h("tr", null, [h("td", { colspan: "8" }, [h("div", { class: "empty-state pad-24", text: "No bills yet today." })])])); return; }
    bills.forEach(function (b) {
      const actions = h("div", { class: "row-actions" });
      if (b.phone) actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Number", "aria-label": "Show customer number for " + b.no, onclick: function () { CMS.showPhone(function () { return Store.billPhone(b.no); }); } }));
      if (b.refundPending) actions.appendChild(h("span", { class: "muted small", text: "Awaiting approval" }));
      else if (b.status === "Paid" && canRefund) actions.appendChild(h("button", { class: "btn btn-ghost btn-sm", text: "Refund", "aria-label": "Refund " + b.no, onclick: function () { openRefund(b.no); } }));
      else if (b.refund) actions.appendChild(h("span", { class: "muted small", title: b.refund.reason, text: "by " + Store.staffName(b.refund.by).split(" ")[0] }));
      body.appendChild(h("tr", null, [
        h("td", null, [h("span", { class: "mono", text: b.no })]), h("td", { text: "T" + b.table }),
        h("td", { class: "hide-sm time", text: CMS.clock(new Date(b.createdAt)) }), h("td", { class: "hide-sm", text: Store.staffName(b.cashier) }),
        h("td", { class: "hide-sm", text: b.method === "Wallet" ? "Mobile wallet" : b.method }),
        h("td", { class: "num nowrap", text: CMS.money(b.total) }),
        h("td", null, [h("span", { class: "pill " + (b.status === "Paid" ? "pill-ready" : b.status === "Pending Payment" ? "pill-preparing" : "pill-cancelled"), text: b.status })]),
        h("td", { class: "actions" }, [actions])
      ]));
    });
  }

  function openRefund(no) {
    const b = billsData().find(function (x) { return x.no === no; });
    if (!b || b.status !== "Paid") { CMS.toast(no + " can't be refunded.", "err"); return; }
    refundNo = no;
    CMS.clearError(document.getElementById("refundErr"));
    document.getElementById("refundTitle").textContent = "Refund " + no + "?";
    document.getElementById("refundSub").textContent = "Table " + b.table + " · " + CMS.money(b.total) + " · " + (b.method === "Wallet" ? "Mobile wallet" : b.method) + ". Refunded amounts are removed from today's revenue.";
    document.getElementById("refundReason").value = "";
    CMS.openModal("refundModal");
    setTimeout(function () { document.getElementById("refundReason").focus(); }, 50);
  }
  async function doRefund(e) {
    e.preventDefault();
    const reason = document.getElementById("refundReason").value;
    const result = await CMS.attempt(function () { return CMS.withStepUp(function () { return Store.refund(refundNo, reason); }); }, document.getElementById("refundErr"));
    if (!result) return;
    CMS.closeModal("refundModal");
    CMS.toast(result.approvalId ? result.message : refundNo + " refunded and logged", result.approvalId ? "info" : "ok");
    if (location.hash) history.replaceState(null, "", location.pathname);
    if (pickedDate) pickDate(pickedDate);
    renderTrend();
  }

  async function exportCsv() {
    const ok = await CMS.attempt(async function () { const day = pickedDate || todayValue(); await Api.download("/reports/sales.csv?date=" + encodeURIComponent(day), "sales-" + day + ".csv"); return true; });
    if (ok) CMS.toast("Sales report exported. This has been logged.", "ok");
  }
})();
