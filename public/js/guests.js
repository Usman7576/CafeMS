// Guests (Manager/Admin): loyalty members and their point history, voucher codes, and guest feedback.
// Numbers are only ever shown masked. Vouchers are approved here, which is why a cashier may apply one
// beyond their own discount limit.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  let tab = "gMembers", members = [], vouchers = [], feedback = { items: [], average: null, count: 0, last30: {} }, query = "";
  const stars = function (n) { return "★★★★★".slice(0, n) + "☆☆☆☆☆".slice(0, 5 - n); };

  App.ready(function () {
    document.querySelectorAll("#guestTabs .tab").forEach(function (t) {
      t.addEventListener("click", function () {
        tab = t.getAttribute("data-tab");
        document.querySelectorAll("#guestTabs .tab").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
        document.querySelectorAll(".page-tab").forEach(function (p) { p.hidden = p.id !== tab; });
        render();
      });
    });
    load();
    Store.on(load);
  });

  async function load() {
    const got = await CMS.attempt(function () { return Promise.all([Api.call("GET", "/customers"), Api.call("GET", "/vouchers"), Api.call("GET", "/feedback")]); });
    if (!got) return;
    members = got[0].customers; vouchers = got[1].vouchers; feedback = got[2];
    const points = members.reduce(function (s, m) { return s + m.points; }, 0);
    const worth = members.reduce(function (s, m) { return s + m.worth; }, 0);
    const active = vouchers.filter(function (v) { return v.active; });
    el("kMembers").textContent = members.length;
    el("kMembersSub").textContent = members.filter(function (m) { return m.visits > 1; }).length + " came back";
    el("kPoints").textContent = points.toLocaleString();
    el("kPointsSub").textContent = "Worth " + CMS.money(worth);
    el("kVouchers").textContent = active.length;
    el("kVouchersSub").textContent = vouchers.reduce(function (s, v) { return s + v.uses; }, 0) + " uses in total";
    el("kRating").textContent = feedback.average === null ? "—" : feedback.average + " / 5";
    el("kRatingSub").textContent = feedback.count ? "From " + feedback.count + " rating" + (feedback.count === 1 ? "" : "s") : "No ratings yet";
    render();
  }

  function render() {
    if (tab === "gMembers") renderMembers();
    if (tab === "gVouchers") renderVouchers();
    if (tab === "gFeedback") renderFeedback();
  }

  function panel(title, sub, action, content) {
    return h("section", { class: "panel" }, [h("div", { class: "panel-head" }, [h("div", null, [h("h3", { text: title }), h("p", { text: sub })]), action]), content]);
  }
  function table(headers, rows, empty) {
    return h("div", { class: "table-wrap flush" }, [h("table", { class: "data-table" }, [
      h("thead", null, [h("tr", null, headers.map(function (t) { return h("th", { text: t }); }))]),
      h("tbody", null, rows.length ? rows : [h("tr", null, [h("td", { colspan: String(headers.length), class: "muted", text: empty })])])
    ])]);
  }

  // ---------- Members ----------
  function renderMembers() {
    const search = h("input", { class: "input input-sm", type: "search", placeholder: "Search name", value: query, "aria-label": "Search members" });
    search.addEventListener("input", function () { query = search.value.trim().toLowerCase(); const pos = search.selectionStart; renderMembers(); const s = el("gMembers").querySelector("input[type=search]"); s.focus(); s.setSelectionRange(pos, pos); });
    const rows = members.filter(function (m) { return !query || m.name.toLowerCase().indexOf(query) !== -1; }).map(function (m) {
      return h("tr", null, [
        h("td", null, [h("b", { text: m.name }), h("small", { class: "sub-line", text: m.phone })]),
        h("td", { class: "num", text: String(m.visits) }), h("td", { class: "num nowrap", text: CMS.money(m.spent) }),
        h("td", { class: "num nowrap", text: m.points + " (" + CMS.money(m.worth) + ")" }),
        h("td", { class: "time hide-sm", text: m.lastVisitAt ? CMS.timeAgo(new Date(m.lastVisitAt).getTime()) : "—" }),
        h("td", { class: "actions" }, [h("button", { class: "btn btn-ghost btn-sm", text: "Points history", onclick: function () { showHistory(m); } })])
      ]);
    });
    el("gMembers").replaceChildren(panel("Loyalty members", "Members join at the till by giving their mobile number. 1 point per Rs 100 by default; change it in Settings.",
      h("div", { class: "input-wrap w-250" }, [App.I("search", 16), search]),
      table(["Member", "Visits", "Spent", "Points", "Last visit", ""], rows, members.length ? "No member matches." : "No members yet.")));
  }

  async function showHistory(m) {
    const got = await CMS.attempt(function () { return Api.call("GET", "/customers/" + encodeURIComponent(m.id) + "/history"); });
    if (!got) return;
    const LABEL = { earn: "Earned", redeem: "Spent", refund: "Refund", adjust: "Adjusted" };
    const list = h("div", { class: "summary" }, got.history.length ? got.history.map(function (r) {
      return h("div", { class: "row" }, [h("span", { text: LABEL[r.type] + (r.billNo ? " · " + r.billNo : "") + " · " + CMS.dateTime(r.at) }), h("b", { text: (r.points > 0 ? "+" : "") + r.points })]);
    }) : [h("div", { class: "row" }, [h("span", { class: "muted", text: "No points yet." })])]);
    CMS.formDialog({ id: "historyModal", icon: "key", title: m.name, sub: m.points + " points · " + m.visits + " visits · " + CMS.money(m.spent) + " spent", fields: [list], okText: "Close", submit: async function () { return true; } });
  }

  // ---------- Vouchers ----------
  function renderVouchers() {
    const today = new Date().toISOString().slice(0, 10);
    const rows = vouchers.map(function (v) {
      const expired = v.expiresOn && v.expiresOn < today;
      const usedUp = v.maxUses && v.uses >= v.maxUses;
      const state = !v.active ? ["Off", "pill-served"] : expired ? ["Expired", "pill-cancelled"] : usedUp ? ["Used up", "pill-cancelled"] : ["Active", "pill-ready"];
      const toggle = h("input", { type: "checkbox", class: "switch", "aria-label": "Voucher " + v.code + " on" });
      toggle.checked = v.active;
      toggle.addEventListener("change", async function () {
        const ok = await CMS.attempt(function () { return Api.call("POST", "/vouchers/" + encodeURIComponent(v.code) + "/active", { active: toggle.checked }); });
        if (!ok) toggle.checked = !toggle.checked; else load();
      });
      return h("tr", null, [
        h("td", null, [h("span", { class: "mono", text: v.code })]),
        h("td", { text: v.kind === "percent" ? v.value + "% off" : CMS.money(v.value) + " off" }),
        h("td", { class: "hide-sm", text: v.minSpend ? "From " + CMS.money(v.minSpend) : "Any bill" }),
        h("td", { class: "hide-sm", text: v.expiresOn || "No end" }),
        h("td", { class: "num", text: v.uses + (v.maxUses ? " / " + v.maxUses : "") }),
        h("td", null, [h("span", { class: "pill " + state[1], text: state[0] })]),
        h("td", { class: "actions" }, [toggle])
      ]);
    });
    el("gVouchers").replaceChildren(panel("Voucher codes", "A cashier types the code when payment starts. Each use is counted and recorded in the audit log.",
      h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 15, text: "New voucher", onclick: newVoucher }),
      table(["Code", "Discount", "Minimum", "Expires", "Uses", "Status", "On"], rows, "No vouchers yet.")));
  }

  function newVoucher() {
    const code = h("input", { class: "input", maxlength: "20", placeholder: "For example: WELCOME10", autocomplete: "off" });
    const kind = h("select", { class: "select" }, [h("option", { value: "percent", text: "Percent off" }), h("option", { value: "amount", text: "Rupees off" })]);
    const value = h("input", { class: "input", type: "number", min: "1", inputmode: "numeric" });
    const min = h("input", { class: "input", type: "number", min: "0", inputmode: "numeric", value: "0" });
    const expires = h("input", { class: "input", type: "date" });
    const uses = h("input", { class: "input", type: "number", min: "1", inputmode: "numeric", placeholder: "No limit" });
    CMS.formDialog({
      id: "voucherModal", icon: "receipt", title: "New voucher", sub: "Codes use letters, numbers and dashes.",
      fields: [CMS.field("Code", code), CMS.field("Type", kind), CMS.field("Discount", value), CMS.field("Minimum spend (Rs)", min), CMS.field("Expires on", expires, "Leave empty for no end date"), CMS.field("Number of uses", uses)],
      okText: "Create voucher",
      submit: async function () {
        const body = { code: code.value.trim().toUpperCase(), kind: kind.value, value: Number(value.value), minSpend: Number(min.value) || 0, expiresOn: expires.value };
        if (uses.value) body.maxUses = Number(uses.value);
        const v = await Api.call("POST", "/vouchers", body);
        CMS.toast(v.code + " created", "ok");
        load();
        return true;
      }
    });
  }

  // ---------- Feedback ----------
  function renderFeedback() {
    const total = [1, 2, 3, 4, 5].reduce(function (s, n) { return s + (feedback.last30[n] || 0); }, 0);
    const bars = h("div", { class: "panel-body" }, [5, 4, 3, 2, 1].map(function (n) {
      const c = feedback.last30[n] || 0;
      return h("div", { class: "hbar" }, [h("div", { class: "hbar-top" }, [h("span", { class: "hbar-label rating", text: stars(n) }), h("span", { class: "hbar-val", text: String(c) })]),
        h("div", { class: "hbar-track" }, [h("div", { class: "hbar-fill" + (n >= 4 ? " first" : ""), css: { width: (total ? (c / total) * 100 : 0) + "%" } })])]);
    }));
    const rows = feedback.items.map(function (f) {
      return h("tr", null, [h("td", { class: "rating", text: stars(f.rating) }), h("td", { text: f.comment || "—" }), h("td", { class: "hide-sm", text: f.name || "Anonymous" }),
        h("td", { class: "hide-sm mono", text: f.billNo || "" }), h("td", { class: "time", text: CMS.dateTime(f.at) })]);
    });
    el("gFeedback").replaceChildren(
      panel("Last 30 days", "Ratings sent from the website's feedback form", null, bars),
      h("div", { class: "mt-20" }),
      panel("Latest comments", "Newest first", null, table(["Rating", "Comment", "Name", "Receipt", "When"], rows, "No feedback yet."))
    );
  }
})();
