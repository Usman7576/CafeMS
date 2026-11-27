// Audit log (Admin): filter/search, hash-chain integrity check, CSV export.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  let sev = "all", user = "", query = "", entries = [];

  App.ready(function () {
    document.querySelectorAll("#sevTabs .tab").forEach(function (t) {
      t.addEventListener("click", function () {
        sev = t.getAttribute("data-s");
        document.querySelectorAll("#sevTabs .tab").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
        renderRows();
      });
    });
    document.getElementById("userFilter").addEventListener("change", function (e) { user = e.target.value; renderRows(); });
    document.getElementById("auditSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); renderRows(); });
    document.getElementById("exportAudit").addEventListener("click", exportCsv);
    renderIntegrity();
    load();
    setInterval(load, 30000);
  });

  async function load() {
    const result = await CMS.attempt(function () { return Store.auditEntries("all"); });
    if (!result) return;
    entries = result;
    renderUsers();
    renderRows();
  }

  async function renderIntegrity() {
    const v = await CMS.attempt(function () { return Store.verifyAudit(); });
    if (!v) return;
    const box = document.getElementById("integrity");
    box.className = "integrity " + (v.ok ? "ok" : "bad");
    box.replaceChildren(
      h("span", { class: "icon-tile", icon: v.ok ? "shield" : "alert", iconSize: 20 }),
      h("div", null, [
        h("b", { text: v.ok ? "Integrity verified" : "Integrity check failed at entry #" + v.brokenAt }),
        h("span", { text: v.ok ? v.count + " entries. Each is linked to the one before it by SHA-256 and signed with Ed25519, so any edit, removal or reordering is detected." : v.reason + " Investigate before trusting this log." })
      ]),
      h("button", { class: "btn btn-secondary btn-sm", icon: "refresh", iconSize: 14, text: "Re-verify", onclick: function () { renderIntegrity(); } }),
      h("button", { class: "btn btn-secondary btn-sm", icon: "shield", iconSize: 14, text: "Mark as reviewed", onclick: function () { markReviewed(); } })
    );
  }

  // Part of the weekly routine: a reminder appears on the Security page if a review is overdue
  async function markReviewed() {
    const ok = await CMS.attempt(function () { return Store.reviewAudit("Reviewed entries on the Audit page").then(function () { return true; }); });
    if (ok) { CMS.toast("Review recorded", "ok"); load(); }
  }

  function renderUsers() {
    const sel = document.getElementById("userFilter");
    const names = new Set(entries.map(function (e) { return e.actor; }));
    sel.replaceChildren();
    sel.appendChild(h("option", { value: "", text: "All users" }));
    Array.from(names).sort().forEach(function (u) { sel.appendChild(h("option", { value: u, text: "@" + u })); });
    sel.value = user;
  }

  function filtered() {
    return entries.filter(function (e) {
      return (sev === "all" || e.severity === sev) && (!user || e.actor === user) &&
        (!query || (e.action + " " + e.details + " " + e.actor).toLowerCase().indexOf(query) !== -1);
    });
  }

  function renderRows() {
    const all = entries;
    ["all", "high", "warning", "info"].forEach(function (s) {
      const el = document.querySelector('#sevTabs [data-n="' + s + '"]');
      if (el) el.textContent = s === "all" ? all.length : all.filter(function (e) { return e.severity === s; }).length;
    });
    const rows = filtered().slice(0, 300);
    const body = document.getElementById("auditBody");
    body.replaceChildren();
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [h("div", { class: "empty-state pad-28", text: "No entries match these filters." })])])); return; }
    rows.forEach(function (e) {
      body.appendChild(h("tr", { class: "sev-row-" + e.severity }, [
        h("td", { class: "mono muted", text: e.seq === undefined ? "" : String(e.seq) }),
        h("td", { class: "time nowrap", text: CMS.dateTime(e.at) }),
        h("td", null, [h("b", { text: e.actor }), h("small", { class: "sub-line", text: e.role })]),
        h("td", { class: "nowrap", text: e.action }),
        h("td", { class: "hide-sm details", text: e.details }),
        h("td", null, [h("span", { class: "pill sev-" + e.severity, text: e.severity === "high" ? "High" : e.severity === "warning" ? "Warning" : "Info" })]),
        h("td", { class: "hide-md mono muted small", title: e.hash || "", text: e.hash ? e.hash.slice(0, 12) : "" })
      ]));
    });
  }

  async function exportCsv() {
    const ok = await CMS.attempt(async function () { await Api.download("/audit.csv?limit=200", "audit-log-" + new Date().toISOString().slice(0, 10) + ".csv"); return true; });
    if (ok) { CMS.toast("Audit log exported. This has been logged.", "ok"); load(); }
  }
})();
