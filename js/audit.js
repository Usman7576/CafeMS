// Audit log (Admin): filter/search, hash-chain integrity check, CSV export.
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  let sev = "all", user = "", query = "";

  document.addEventListener("DOMContentLoaded", function () {
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
    render();
    Store.on(render);
  });

  function render() { renderIntegrity(); renderUsers(); renderRows(); }

  function renderIntegrity() {
    const v = Store.verifyAudit();
    const box = document.getElementById("integrity");
    box.className = "integrity " + (v.ok ? "ok" : "bad");
    box.innerHTML = "";
    box.append(
      h("span", { class: "icon-tile", icon: v.ok ? "shield" : "alert", iconSize: 20 }),
      h("div", null, [
        h("b", { text: v.ok ? "Integrity verified" : "Integrity check failed at entry #" + v.brokenAt }),
        h("span", { text: v.ok ? v.count + " entries. Each one stores a hash of the previous entry, so any edit or deletion breaks the chain and is detected here." : "An entry was modified or removed. Investigate before trusting this log." })
      ]),
      h("button", { class: "btn btn-secondary btn-sm", icon: "refresh", iconSize: 14, text: "Re-verify", onclick: function () { renderIntegrity(); CMS.toast(Store.verifyAudit().ok ? "Chain verified" : "Chain broken", Store.verifyAudit().ok ? "ok" : "err"); } })
    );
  }

  function renderUsers() {
    const sel = document.getElementById("userFilter");
    const names = {};
    Store.auditLog().forEach(function (e) { names[e.user] = e.name; });
    sel.innerHTML = "";
    sel.appendChild(h("option", { value: "", text: "All users" }));
    Object.keys(names).sort().forEach(function (u) { sel.appendChild(h("option", { value: u, text: names[u] + " (@" + u + ")" })); });
    sel.value = user;
  }

  function filtered() {
    return Store.auditLog().filter(function (e) {
      return (sev === "all" || e.severity === sev) && (!user || e.user === user) &&
        (!query || (e.action + " " + e.details + " " + e.name).toLowerCase().indexOf(query) !== -1);
    });
  }

  function renderRows() {
    const all = Store.auditLog();
    ["all", "high", "warning", "info"].forEach(function (s) {
      const el = document.querySelector('#sevTabs [data-n="' + s + '"]');
      if (el) el.textContent = s === "all" ? all.length : all.filter(function (e) { return e.severity === s; }).length;
    });
    const rows = filtered().slice(0, 300);
    const body = document.getElementById("auditBody");
    body.innerHTML = "";
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [h("div", { class: "empty-state", style: "padding:28px", text: "No entries match these filters." })])])); return; }
    rows.forEach(function (e) {
      body.appendChild(h("tr", { class: "sev-row-" + e.severity }, [
        h("td", { class: "mono muted", text: String(e.id) }),
        h("td", { class: "time nowrap", text: CMS.dateTime(e.at) }),
        h("td", null, [h("b", { text: e.name }), h("small", { class: "sub-line", text: e.role })]),
        h("td", { class: "nowrap", text: e.action }),
        h("td", { class: "hide-sm details", text: e.details }),
        h("td", null, [h("span", { class: "pill sev-" + e.severity, text: e.severity === "high" ? "High" : e.severity === "warning" ? "Warning" : "Info" })]),
        h("td", { class: "hide-md mono muted small", title: "prev " + e.prev, text: e.hash })
      ]));
    });
  }

  function exportCsv() {
    const rows = [["#", "Time", "Username", "Name", "Role", "Action", "Details", "Severity", "Previous hash", "Hash"]];
    filtered().slice().reverse().forEach(function (e) { rows.push([e.id, new Date(e.at).toISOString(), e.user, e.name, e.role, e.action, e.details, e.severity, e.prev, e.hash]); });
    Store.log(me, "Audit log exported", (rows.length - 1) + " entries", "warning");
    CMS.downloadCSV("audit-log-" + new Date().toISOString().slice(0, 10) + ".csv", rows);
    CMS.toast("Audit log exported", "ok");
  }
})();
