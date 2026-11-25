// Team: clock in and out, my week, the rota, leave requests; for managers also timesheets, leave
// approvals and the tips share. The server checks every rule; this page shows and collects.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  const role = App.session.role;
  const manager = role === "Manager", reader = role === "Manager" || role === "Admin", onFloor = role !== "Admin";
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let tab = onFloor ? "tMine" : "tRota", week = null, tipsDate = null;
  const hours = function (min) { return (Math.round((min || 0) / 6) / 10).toFixed(1) + " h"; };
  const isoDay = function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const shiftWeek = function (n) { const d = new Date((week || isoDay(new Date())) + "T12:00:00"); d.setDate(d.getDate() + n * 7); week = isoDay(d); render(); };

  App.ready(function () {
    const tabs = [["tMine", "My time", onFloor], ["tRota", "Rota", true], ["tSheets", "Timesheets", reader], ["tLeave", "Leave", reader], ["tTips", "Tips", reader]].filter(function (t) { return t[2]; });
    el("teamTabs").replaceChildren.apply(el("teamTabs"), tabs.map(function (t) {
      return h("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(t[0] === tab), text: t[1], onclick: function () {
        tab = t[0];
        el("teamTabs").querySelectorAll(".tab").forEach(function (b, i) { b.setAttribute("aria-selected", String(tabs[i][0] === tab)); });
        document.querySelectorAll(".page-tab").forEach(function (p) { p.hidden = p.id !== tab; });
        render();
      } });
    }));
    document.querySelectorAll(".page-tab").forEach(function (p) { p.hidden = p.id !== tab; });
    el("tabletClock").addEventListener("click", tabletClock);
    render();
    Store.on(render);
  });

  function render() {
    if (tab === "tMine") renderMine();
    if (tab === "tRota") renderRota();
    if (tab === "tSheets") renderSheets();
    if (tab === "tLeave") renderLeave();
    if (tab === "tTips") renderTips();
  }
  function panel(title, sub, action, content) {
    return h("section", { class: "panel mb-20" }, [h("div", { class: "panel-head" }, [h("div", null, [h("h3", { text: title }), sub ? h("p", { text: sub }) : null]), action]), content]);
  }
  function table(headers, rows, empty) {
    return h("div", { class: "table-wrap flush" }, [h("table", { class: "data-table" }, [
      h("thead", null, [h("tr", null, headers.map(function (t) { return h("th", { text: t }); }))]),
      h("tbody", null, rows.length ? rows : [h("tr", null, [h("td", { colspan: String(headers.length), class: "muted", text: empty })])])
    ])]);
  }
  const weekNav = function (label) {
    return h("div", { class: "row-actions" }, [
      h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Previous week", text: "‹", onclick: function () { shiftWeek(-1); } }),
      h("span", { class: "small", text: label }),
      h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Next week", text: "›", onclick: function () { shiftWeek(1); } })
    ]);
  };
  const weekLabel = function (days) { return "Week of " + new Date(days[0] + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }); };

  // ---------- My time ----------
  async function renderMine() {
    const me = await CMS.attempt(function () { return Api.call("GET", "/timeclock/me"); });
    if (!me) return;
    const clockBtn = h("button", { type: "button", class: "btn btn-lg " + (me.clockedIn ? "btn-secondary" : "btn-primary"), text: me.clockedIn ? "Clock out" : "Clock in", onclick: function () {
      CMS.busy(clockBtn, async function () {
        const r = await CMS.attempt(function () { return Api.call("POST", "/timeclock", { action: me.clockedIn ? "out" : "in" }); });
        if (r) { CMS.toast(r.status === "in" ? "Clocked in" : "Clocked out · " + hours(r.entry.minutes), "ok"); renderMine(); }
      });
    } });
    const status = h("div", { class: "clock-card" + (me.clockedIn ? " on" : "") }, [
      h("div", null, [h("b", { text: me.clockedIn ? "On shift since " + CMS.clock(new Date(me.clockedIn.since)) : "Not clocked in" }), h("small", { text: "This week: " + hours(me.weekMinutes) })]),
      clockBtn
    ]);
    const shifts = me.shifts.map(function (s) { return h("li", null, [h("span", { class: "tno", text: DAYS[(new Date(s.date + "T12:00:00").getDay() + 6) % 7] }), h("div", { class: "meta" }, [h("b", { text: s.date + " · " + s.start + "–" + s.end }), h("small", { text: s.note || s.role })])]); });
    const leaves = me.leave.map(function (l) { return h("li", null, [h("span", { class: "tno " + (l.status === "Approved" ? "ok" : l.status === "Rejected" ? "danger" : "warn"), icon: "calendar", iconSize: 16 }), h("div", { class: "meta" }, [h("b", { text: l.from + (l.to !== l.from ? " to " + l.to : "") + " · " + l.status }), h("small", { text: l.reason })])]); });
    el("tMine").replaceChildren(
      status,
      h("div", { class: "report-grid" }, [
        panel("My coming shifts", "From the rota", null, shifts.length ? h("ul", { class: "ready-list" }, shifts) : h("p", { class: "panel-body muted", text: "No shifts planned yet." })),
        panel("My leave", "Requests and answers", h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 15, text: "Ask for leave", onclick: askLeave }), leaves.length ? h("ul", { class: "ready-list" }, leaves) : h("p", { class: "panel-body muted", text: "No leave requests." }))
      ])
    );
  }

  function askLeave() {
    const from = h("input", { class: "input", type: "date", min: isoDay(new Date()) });
    const to = h("input", { class: "input", type: "date", min: isoDay(new Date()) });
    const reason = h("input", { class: "input", maxlength: "120", placeholder: "For example: family wedding" });
    CMS.formDialog({ id: "leaveModal", icon: "calendar", title: "Ask for leave", sub: "A manager approves or rejects it.", fields: [CMS.field("First day", from), CMS.field("Last day", to), CMS.field("Reason", reason)], okText: "Send request",
      submit: async function () { await Api.call("POST", "/leave", { from: from.value, to: to.value || from.value, reason: reason.value.trim() }); CMS.toast("Leave request sent", "ok"); renderMine(); return true; } });
  }

  // A shared tablet: tap your name, enter your PIN, clock in or out
  async function tabletClock() {
    const got = await CMS.attempt(function () { return Api.call("GET", "/auth/switch/people"); });
    if (!got) return;
    const people = got.people.concat(got.hasPin && got.pinAllowed ? [{ username: App.session.user, name: App.session.name, role: role }] : []);
    if (!people.length) { CMS.toast("Nobody has set a PIN yet. Staff set one on their My account page.", "err"); return; }
    const who = h("select", { class: "select" }, people.sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (p) { return h("option", { value: p.username, text: p.name + " · " + p.role }); }));
    const pin = h("input", { class: "input", type: "password", inputmode: "numeric", maxlength: "6", autocomplete: "off" });
    let action = "in";
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Clock in or out" }, [["in", "Clock in"], ["out", "Clock out"]].map(function (a) {
      const b = h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(a[0] === action), text: a[1] });
      b.addEventListener("click", function () { action = a[0]; seg.querySelectorAll(".seg-btn").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); }); });
      return b;
    }));
    CMS.formDialog({ id: "pinClockModal", icon: "clock", title: "Clock in or out with PIN", sub: "For a shared tablet. Five wrong PINs pause that person's PIN for 15 minutes.", fields: [CMS.field("Your name", who), h("div", { class: "field" }, [seg]), CMS.field("Your PIN", pin)], okText: "Confirm",
      submit: async function () {
        const r = await Api.call("POST", "/timeclock/pin", { username: who.value, pin: pin.value, action: action });
        CMS.toast(who.options[who.selectedIndex].text.split(" · ")[0] + (r.status === "in" ? " clocked in" : " clocked out · " + hours(r.entry.minutes)), "ok");
        render();
        return true;
      } });
  }

  // ---------- Rota ----------
  async function renderRota() {
    const data = await CMS.attempt(function () { return Api.call("GET", "/rota" + (week ? "?week=" + week : "")); });
    if (!data) return;
    week = data.week[0];
    const today = isoDay(new Date());
    const rows = data.staff.map(function (p) {
      return h("tr", null, [h("th", { scope: "row" }, [h("b", { text: p.name }), h("small", { class: "sub-line", text: p.role })])].concat(data.week.map(function (d) {
        const away = data.leave.some(function (l) { return l.username === p.username && l.from <= d && l.to >= d; });
        const cell = h("td", { class: "rota-cell" + (d === today ? " today" : "") + (away ? " away" : "") });
        if (away) cell.appendChild(h("span", { class: "pill no-dot", text: "Leave" }));
        data.shifts.filter(function (s) { return s.username === p.username && s.date === d; }).forEach(function (s) {
          cell.appendChild(h("button", { type: "button", class: "rota-shift", text: s.start + "–" + s.end, title: s.note || "", disabled: !manager, onclick: function () { removeShift(s, p); } }));
        });
        if (manager && !away) cell.appendChild(h("button", { type: "button", class: "rota-add", "aria-label": "Add a shift for " + p.name + " on " + d, text: "+", onclick: function () { addShift(p, d); } }));
        return cell;
      })));
    });
    const head = [h("th", { text: "Staff" })].concat(data.week.map(function (d, i) { return h("th", { class: d === today ? "today" : "", text: DAYS[i] + " " + d.slice(8) }); }));
    el("tRota").replaceChildren(panel("Rota", manager ? "Tap + to plan a shift, or a shift to remove it." : "Who works when this week.", weekNav(weekLabel(data.week)),
      h("div", { class: "table-wrap flush" }, [h("table", { class: "data-table rota" }, [h("thead", null, [h("tr", null, head)]), h("tbody", null, rows)])])));
  }
  function addShift(p, d) {
    const start = h("input", { class: "input", type: "time", value: "09:00" });
    const end = h("input", { class: "input", type: "time", value: "17:00" });
    const note = h("input", { class: "input", maxlength: "60", placeholder: "Optional, for example: opening" });
    CMS.formDialog({ id: "shiftModal", icon: "calendar", title: p.name + " · " + d, fields: [CMS.field("Start", start), CMS.field("End", end), CMS.field("Note", note)], okText: "Add shift",
      submit: async function () { await Api.call("POST", "/rota", { username: p.username, date: d, start: start.value, end: end.value, note: note.value.trim() }); renderRota(); return true; } });
  }
  async function removeShift(s, p) {
    const ok = await CMS.confirm({ title: "Remove this shift?", message: p.name + " · " + s.date + " " + s.start + "–" + s.end, okText: "Remove", icon: "calendar" });
    if (ok && await CMS.attempt(function () { return Api.call("DELETE", "/rota/" + encodeURIComponent(s.id)).then(function () { return true; }); })) renderRota();
  }

  // ---------- Timesheets ----------
  async function renderSheets() {
    const data = await CMS.attempt(function () { return Api.call("GET", "/timesheets" + (week ? "?week=" + week : "")); });
    if (!data) return;
    week = data.week[0];
    const rows = [];
    data.people.forEach(function (p) {
      rows.push(h("tr", null, [h("th", { scope: "row" }, [h("b", { text: p.name }), h("small", { class: "sub-line", text: p.role + (p.open ? " · on shift now" : "") })])]
        .concat(data.week.map(function (d) { return h("td", { class: "num", text: p.days[d] ? hours(p.days[d]) : "—" }); }), [h("td", { class: "num" }, [h("b", { text: hours(p.minutes) })])])));
      if (manager) p.entries.forEach(function (e) {
        rows.push(h("tr", { class: "entry-row" }, [h("td", { colspan: "9", class: "small muted" }, [
          CMS.dateTime(e.in) + " → " + (e.out ? CMS.clock(new Date(e.out)) : "still on shift") + (e.edited ? " · corrected" : "") + (e.by === "pin" ? " · PIN" : "") + " ",
          h("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Fix", onclick: function () { fixEntry(e); } })
        ])]));
      });
    });
    const csv = h("button", { class: "btn btn-secondary btn-sm", icon: "file", iconSize: 15, text: "Download CSV", onclick: function () { CMS.attempt(function () { return Api.download("/timesheets.csv?week=" + week, "timesheet-" + week + ".csv"); }); } });
    el("tSheets").replaceChildren(panel("Timesheets", "Hours from the time clock, for payroll", h("div", { class: "row-actions" }, [weekNav(weekLabel(data.week)), csv]),
      table(["Staff"].concat(data.week.map(function (d, i) { return DAYS[i] + " " + d.slice(8); }), ["Total"]), rows, "Nobody clocked in this week.")));
  }
  function fixEntry(e) {
    const local = function (iso) { const d = new Date(iso); return isoDay(d) + "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
    const inAt = h("input", { class: "input", type: "datetime-local", value: local(e.in) });
    const outAt = h("input", { class: "input", type: "datetime-local", value: e.out ? local(e.out) : "" });
    const reason = h("input", { class: "input", maxlength: "80", placeholder: "For example: forgot to clock out" });
    CMS.formDialog({ id: "fixModal", icon: "clock", title: "Correct " + e.name + "'s time", sub: "The old times stay in the audit log.", fields: [CMS.field("Clocked in", inAt), CMS.field("Clocked out", outAt), CMS.field("Reason", reason)], okText: "Save",
      submit: async function () {
        await Api.call("PUT", "/timeclock/" + encodeURIComponent(e.id), { in: new Date(inAt.value).toISOString(), out: outAt.value ? new Date(outAt.value).toISOString() : "", reason: reason.value.trim() });
        CMS.toast("Time corrected", "ok"); renderSheets(); return true;
      } });
  }

  // ---------- Leave ----------
  async function renderLeave() {
    const data = await CMS.attempt(function () { return Api.call("GET", "/leave"); });
    if (!data) return;
    const rows = data.leave.map(function (l) {
      const pill = { Pending: "pill-preparing", Approved: "pill-ready", Rejected: "pill-cancelled" }[l.status];
      const act = manager && l.status === "Pending" && l.username !== App.session.user ? h("div", { class: "row-actions" }, [
        h("button", { class: "btn btn-primary btn-sm", text: "Approve", onclick: function () { decide(l, true); } }),
        h("button", { class: "btn btn-ghost btn-sm", text: "Reject", onclick: function () { decide(l, false); } })
      ]) : null;
      return h("tr", null, [h("td", null, [h("b", { text: l.name })]), h("td", { class: "nowrap", text: l.from + (l.to !== l.from ? " to " + l.to : "") }), h("td", { text: l.reason }), h("td", null, [h("span", { class: "pill " + pill, text: l.status })]), h("td", { class: "actions" }, [act])]);
    });
    el("tLeave").replaceChildren(panel("Leave requests", "Waiting requests first; your own are decided by another manager", null, table(["Staff", "Dates", "Reason", "Status", ""], rows, "No leave requests.")));
  }
  async function decide(l, approve) {
    const r = await CMS.attempt(function () { return Api.call("POST", "/leave/" + encodeURIComponent(l.id) + (approve ? "/approve" : "/reject"), {}); });
    if (!r) return;
    CMS.toast(l.name + "'s leave " + (approve ? "approved" : "rejected") + (r.clashes && r.clashes.length ? " · " + r.clashes.length + " planned shift" + (r.clashes.length === 1 ? " needs" : "s need") + " cover" : ""), r.clashes && r.clashes.length ? "info" : "ok");
    renderLeave();
  }

  // ---------- Tips ----------
  async function renderTips() {
    const data = await CMS.attempt(function () { return Api.call("GET", "/tips" + (tipsDate ? "?date=" + tipsDate : "")); });
    if (!data) return;
    const pick = h("input", { class: "input input-sm", type: "date", value: data.date, max: isoDay(new Date()), "aria-label": "Day" });
    pick.addEventListener("change", function () { tipsDate = pick.value; renderTips(); });
    const rows = data.people.map(function (p) { return h("tr", null, [h("td", null, [h("b", { text: p.name })]), h("td", { class: "num", text: hours(p.minutes) }), h("td", { class: "num", text: data.minutes ? Math.round(p.minutes / data.minutes * 100) + "%" : "—" }), h("td", { class: "num" }, [h("b", { text: CMS.money(p.share) })])]); });
    el("tTips").replaceChildren(panel("Tips · " + CMS.money(data.total), "Shared by the hours each person worked that day, from the time clock", pick,
      table(["Staff", "Hours", "Share of hours", "Tips"], rows, data.total ? "Nobody clocked in that day, so there is no one to share with." : "No tips that day.")));
  }
})();
