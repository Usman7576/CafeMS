// Insights (Manager/Admin): sales over a range of days, busiest hours, product mix with cost and margin,
// profit, staff and pay, and the daily close. Every figure is worked out by the server; CSVs come from
// the server too, and "Print / PDF" uses the browser's own print, where "Save as PDF" can be chosen.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const isoDay = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const daysAgo = function (n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };
  const PRESETS = [
    ["Today", function () { return [daysAgo(0), daysAgo(0)]; }],
    ["Yesterday", function () { return [daysAgo(1), daysAgo(1)]; }],
    ["7 days", function () { return [daysAgo(6), daysAgo(0)]; }],
    ["30 days", function () { return [daysAgo(29), daysAgo(0)]; }],
    ["This month", function () { const d = new Date(); return [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), daysAgo(0)]; }]
  ];
  let tab = "iSummary", from = daysAgo(6), to = daysAgo(0), preset = "7 days", closeDate = daysAgo(0);
  const pct = function (n) { return n === null || n === undefined ? "—" : n + "%"; };

  App.ready(function () {
    const tabs = [["iSummary", "Summary"], ["iMix", "Products"], ["iProfit", "Profit"], ["iStaff", "Staff"], ["iClose", "Daily close"]];
    el("insightTabs").replaceChildren.apply(el("insightTabs"), tabs.map(function (t) {
      return h("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(t[0] === tab), text: t[1], onclick: function () {
        tab = t[0];
        el("insightTabs").querySelectorAll(".tab").forEach(function (b, i) { b.setAttribute("aria-selected", String(tabs[i][0] === tab)); });
        document.querySelectorAll(".page-tab").forEach(function (p) { p.hidden = p.id !== tab; });
        render();
      } });
    }));
    renderPresets();
    el("fromDate").max = el("toDate").max = daysAgo(0);
    el("fromDate").addEventListener("change", function () { from = el("fromDate").value; preset = null; renderPresets(); render(); });
    el("toDate").addEventListener("change", function () { to = el("toDate").value; preset = null; renderPresets(); render(); });
    el("printBtn").addEventListener("click", function () { window.print(); });
    render();
  });

  function renderPresets() {
    el("fromDate").value = from; el("toDate").value = to;
    el("presets").replaceChildren.apply(el("presets"), PRESETS.map(function (p) {
      return h("button", { type: "button", class: "seg-btn", role: "radio", "aria-checked": String(preset === p[0]), text: p[0], onclick: function () { const r = p[1](); from = r[0]; to = r[1]; preset = p[0]; renderPresets(); render(); } });
    }));
    el("rangeLabel").textContent = (from === to ? from : from + " to " + to) + " · figures in PKR";
  }

  const query = function () { return "?from=" + from + "&to=" + to; };
  const kpi = function (label, value, sub) { return h("div", { class: "kpi" }, [h("div", null, [h("small", { text: label }), h("strong", { text: value }), sub ? h("div", { class: "sub", text: sub }) : null])]); };
  const panel = function (title, sub, action, content) { return h("section", { class: "panel mb-20" }, [h("div", { class: "panel-head" }, [h("div", null, [h("h3", { text: title }), sub ? h("p", { text: sub }) : null]), action]), content]); };
  const table = function (headers, rows, empty) {
    return h("div", { class: "table-wrap flush" }, [h("table", { class: "data-table" }, [
      h("thead", null, [h("tr", null, headers.map(function (t) { return h("th", { text: t }); }))]),
      h("tbody", null, rows.length ? rows : [h("tr", null, [h("td", { colspan: String(headers.length), class: "muted", text: empty })])])
    ])]);
  };
  const csvButton = function (path, name) {
    return h("button", { class: "btn btn-secondary btn-sm no-print", icon: "file", iconSize: 15, text: "CSV", onclick: function () { CMS.attempt(function () { return Api.download("/insights/" + path + query(), name + "-" + from + "-to-" + to + ".csv"); }); } });
  };

  function render() {
    if (tab === "iSummary") renderSummary();
    if (tab === "iMix") renderMix();
    if (tab === "iProfit") renderProfit();
    if (tab === "iStaff") renderStaff();
    if (tab === "iClose") renderClose();
  }

  // ---------- Summary ----------
  async function renderSummary() {
    const s = await CMS.attempt(function () { return Api.call("GET", "/insights/summary" + query()); });
    if (!s) return;
    const chart = h("div", { class: "chart" });
    CMS.barChart(chart, s.byDay.map(function (d) { return { label: d.date.slice(5), value: d.revenue, title: d.date + " · " + CMS.money(d.revenue) + " · " + d.bills + " bills" }; }), { height: 200, label: "Revenue per day" });
    // Busiest hours: one row per weekday, darker where more was taken
    const max = Math.max.apply(null, s.heat.flat().concat([1]));
    const hours = []; for (let hr = 8; hr < 24; hr++) hours.push(hr);
    const heat = h("div", { class: "table-wrap flush" }, [h("table", { class: "heat" }, [
      h("thead", null, [h("tr", null, [h("th", { text: "" })].concat(hours.map(function (hr) { return h("th", { text: String(hr) }); })))]),
      h("tbody", null, s.heat.map(function (row, d) {
        return h("tr", null, [h("th", { scope: "row", text: DAYS[d] })].concat(hours.map(function (hr) {
          const v = row[hr];
          return h("td", { title: DAYS[d] + " " + hr + ":00 · " + CMS.money(v), "aria-label": DAYS[d] + " " + hr + ":00, " + CMS.money(v), css: { background: v ? "rgba(139, 94, 60, " + (0.12 + 0.88 * v / max).toFixed(2) + ")" : "" } });
        })));
      }))
    ])]);
    const split = function (obj, labels) { return h("div", { class: "summary" }, Object.keys(obj).filter(function (k) { return obj[k]; }).map(function (k) { return h("div", { class: "row" }, [h("span", { text: labels[k] || k }), h("b", { text: CMS.money(obj[k]) })]); })); };
    el("iSummary").replaceChildren(
      h("section", { class: "kpis kpis-6" }, [
        kpi("Revenue", CMS.money(s.revenue), "Net " + CMS.money(s.net) + " without tax"),
        kpi("Visits", String(s.checks), s.bills + " payments"),
        kpi("Average visit", CMS.money(s.avgTicket), "Per bill, split bills counted once"),
        kpi("Discounts", CMS.money(s.discounts), s.service ? "Service charge " + CMS.money(s.service) : ""),
        kpi("Tips", CMS.money(s.tips), "Not counted as sales"),
        kpi("Refunds", CMS.money(s.refundAmount), s.refunds + " bills")
      ]),
      panel("Revenue per day", null, csvButton("days.csv", "daily-sales"), h("div", { class: "panel-body" }, [chart])),
      panel("Busiest hours", "Revenue by weekday and hour, across the range", null, heat),
      h("div", { class: "report-grid" }, [
        panel("By payment method", null, null, h("div", { class: "panel-body" }, [split(s.byMethod, { Wallet: "Mobile wallet", Points: "Loyalty points" })])),
        panel("By order type", null, null, h("div", { class: "panel-body" }, [split(s.byType, { "dine-in": "Dine-in", takeaway: "Takeaway", delivery: "Delivery" })])),
        panel("By category", "Before tax", null, h("div", { class: "panel-body" }, [(function () { const c = h("div"); CMS.hBars(c, s.byCat.map(function (x) { return { label: x.cat, value: x.value, display: CMS.money(x.value) }; })); return c; })()]))
      ])
    );
  }

  // ---------- Products ----------
  async function renderMix() {
    const m = await CMS.attempt(function () { return Api.call("GET", "/insights/mix" + query()); });
    if (!m) return;
    const rows = m.items.map(function (i) {
      return h("tr", null, [h("td", null, [h("b", { text: i.name }), h("small", { class: "sub-line", text: i.cat })]), h("td", { class: "num", text: String(i.qty) }),
        h("td", { class: "num", text: CMS.money(i.sales) }), h("td", { class: "num hide-sm", text: i.share + "%" }), h("td", { class: "num hide-sm", text: CMS.money(i.cost) }),
        h("td", { class: "num", text: CMS.money(i.profit) }), h("td", { class: "num" + (i.cost && i.margin < 60 ? " margin-low" : ""), text: i.cost ? i.margin + "%" : "—" })]);
    });
    el("iMix").replaceChildren(panel("Product mix · " + CMS.money(m.total), "Ingredient cost uses today's average costs; items without a recipe show no margin.", csvButton("mix.csv", "product-mix"),
      table(["Item", "Sold", "Sales", "Share", "Ingredients", "Profit", "Margin"], rows, "Nothing was sold in this range.")));
  }

  // ---------- Profit ----------
  async function renderProfit() {
    const p = await CMS.attempt(function () { return Api.call("GET", "/insights/profit" + query()); });
    if (!p) return;
    const line = function (label, value, cls) { return h("div", { class: "row " + (cls || "") }, [h("span", { text: label }), h("b", { text: (value < 0 ? "−" : "") + CMS.money(Math.abs(value)) })]); };
    el("iProfit").replaceChildren(
      h("section", { class: "kpis" }, [kpi("Profit", CMS.money(p.profit), pct(p.profitPct) + " of net sales"), kpi("Food cost", pct(p.foodCostPct), "Ingredients and waste"), kpi("Labour", pct(p.labourPct), CMS.money(p.labour) + " in pay"), kpi("Net sales", CMS.money(p.net), "Without tax")]),
      panel("Profit and loss", "Rent, bills and other overheads are not included", null, h("div", { class: "panel-body" }, [h("div", { class: "summary" }, [
        line("Net sales", p.net), line("Ingredients used", -p.ingredients), line("Waste", -p.waste), line("Gross profit", p.grossProfit, "total"), line("Staff pay", -p.labour), line("Profit", p.profit, "total")
      ]), p.missingRates.length ? h("p", { class: "alert alert-warn show mt-12", text: "No pay rate yet for " + p.missingRates.join(", ") + ", so their hours count as Rs 0. Set rates on the Staff tab." }) : null]))
    );
  }

  // ---------- Staff and pay ----------
  async function renderStaff() {
    const [s, rates] = await Promise.all([
      CMS.attempt(function () { return Api.call("GET", "/insights/staff" + query()); }),
      CMS.attempt(function () { return Api.call("GET", "/pay-rates"); })
    ]);
    if (!s || !rates) return;
    const rows = s.people.map(function (p) {
      return h("tr", null, [h("td", null, [h("b", { text: p.name }), h("small", { class: "sub-line", text: p.role })]), h("td", { class: "num", text: p.orders ? String(p.orders) : "—" }),
        h("td", { class: "num", text: p.sold ? CMS.money(p.sold) : "—" }), h("td", { class: "num hide-sm", text: p.collected ? CMS.money(p.collected) : "—" }), h("td", { class: "num hide-sm", text: p.tips ? CMS.money(p.tips) : "—" }),
        h("td", { class: "num", text: (Math.round(p.minutes / 6) / 10) + " h" }), h("td", { class: "num", text: p.labour ? CMS.money(p.labour) : "—" }), h("td", { class: "num", text: p.salesPerHour ? CMS.money(p.salesPerHour) : "—" })]);
    });
    const rateRows = rates.rates.map(function (r) {
      const box = h("input", { class: "input input-sm rate-input", type: "number", min: "0", step: "10", inputmode: "numeric", value: String(r.rate || ""), "aria-label": "Hourly rate for " + r.name, placeholder: "0" });
      const save = h("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Save", onclick: function () {
        CMS.busy(save, async function () { if (await CMS.attempt(function () { return Api.call("PUT", "/pay-rates/" + encodeURIComponent(r.username), { rate: Number(box.value) || 0 }); })) { CMS.toast(r.name + "'s rate saved", "ok"); renderStaff(); } });
      } });
      return h("tr", null, [h("td", null, [h("b", { text: r.name }), h("small", { class: "sub-line", text: r.role })]), h("td", null, [h("div", { class: "input-group" }, [h("span", { class: "addon", text: "Rs" }), box, h("span", { class: "addon", text: "/ h" })])]), h("td", { class: "actions" }, [save])]);
    });
    el("iStaff").replaceChildren(
      panel("Staff sales", "Sold by the person who took the order; collected by the cashier who took the money", csvButton("staff.csv", "staff-sales"),
        table(["Staff", "Orders", "Sold", "Collected", "Tips", "Hours", "Pay", "Sold per hour"], rows, "No sales or hours in this range.")),
      panel("Hourly pay rates", "Used to work out staff pay and labour cost. Private to managers and admins; every change is recorded.", null, table(["Staff", "Rate", ""], rateRows, "No staff yet."))
    );
  }

  // ---------- Daily close ----------
  async function renderClose() {
    const c = await CMS.attempt(function () { return Api.call("GET", "/insights/close?date=" + closeDate); });
    if (!c) return;
    const pick = h("input", { class: "input input-sm no-print", type: "date", value: c.date, max: daysAgo(0), "aria-label": "Day" });
    pick.addEventListener("change", function () { closeDate = pick.value; renderClose(); });
    const row = function (a, b, cls) { return h("div", { class: "row " + (cls || "") }, [h("span", { text: a }), h("b", { text: b })]); };
    const warn = [];
    if (c.unpaid) warn.push(c.unpaid + " bill" + (c.unpaid === 1 ? " is" : "s are") + " still waiting for payment.");
    if (c.shifts.open) warn.push(c.shifts.open + " cashier shift" + (c.shifts.open === 1 ? " is" : "s are") + " still open.");
    el("iClose").replaceChildren(panel("Daily close · " + c.date, "Everything taken, given away and lost on the day", pick, h("div", { class: "panel-body" }, [
      warn.length ? h("div", { class: "alert alert-warn show", text: warn.join(" ") }) : null,
      h("div", { class: "report-grid" }, [
        h("div", { class: "summary" }, [row("Revenue", CMS.money(c.revenue), "total"), row("Net sales (without tax)", CMS.money(c.net)), row("Tax", CMS.money(c.tax)), c.service ? row("Service charge", CMS.money(c.service)) : null, row("Discounts given", CMS.money(c.discounts)), row("Tips", CMS.money(c.tips)), row("Visits / payments", c.checks + " / " + c.bills), row("Average visit", CMS.money(c.avgTicket))].filter(Boolean)),
        h("div", { class: "summary" }, [row("Cash", CMS.money(c.byMethod.Cash)), row("Card", CMS.money(c.byMethod.Card)), row("Mobile wallet", CMS.money(c.byMethod.Wallet)), c.byMethod.Points ? row("Loyalty points", CMS.money(c.byMethod.Points)) : null,
          row("Refunds", c.refunds + " · " + CMS.money(c.refundAmount)), row("Voided orders", c.voids + " · " + CMS.money(c.voidValue)), row("Waste", CMS.money(c.waste)),
          row("Drawers (" + c.shifts.count + " shifts)", c.shifts.overShort === 0 ? "Balanced" : (c.shifts.overShort > 0 ? "Over " : "Short ") + CMS.money(Math.abs(c.shifts.overShort)), "total")].filter(Boolean))
      ]),
      h("h3", { class: "mt-20", text: "Best sellers" }),
      h("div", { class: "summary mt-12" }, c.top.length ? c.top.map(function (t) { return row(t.qty + " × " + t.name, CMS.money(t.sales)); }) : [row("Nothing sold", "")])
    ])));
  }
})();
