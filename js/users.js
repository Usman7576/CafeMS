// Staff & roles (Admin): create accounts, change roles, enable/disable access,
// and a read-only permission matrix. All changes are audit-logged (SR-3, SR-7).
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  const ROLE_ICON = { Waiter: "clipboard", Kitchen: "chef", Cashier: "receipt", Manager: "chart", Admin: "shield" };
  const ROLE_DESC = {
    Waiter: "Take and update orders, view table status",
    Kitchen: "View order queue, update order status",
    Cashier: "Create bills, take payments, discounts up to 10%",
    Manager: "Inventory, reports, refunds, discounts up to 25%",
    Admin: "Users, roles, menu, prices, audit log"
  };
  let query = "", roleTarget = null, roleChoice = null;

  document.addEventListener("DOMContentLoaded", function () {
    const sel = document.getElementById("uRole");
    Store.ROLES.forEach(function (r) { sel.appendChild(h("option", { value: r, text: r })); });
    document.getElementById("userSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); renderRows(); });
    document.getElementById("addUser").addEventListener("click", function () {
      CMS.clearError(document.getElementById("userErr"));
      document.getElementById("uName").value = ""; document.getElementById("uUser").value = ""; sel.value = "Waiter";
      CMS.openModal("userModal");
      setTimeout(function () { document.getElementById("uName").focus(); }, 50);
    });
    document.getElementById("uName").addEventListener("input", function (e) {
      const u = document.getElementById("uUser");
      if (!u.dataset.touched) u.value = e.target.value.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    });
    document.getElementById("uUser").addEventListener("input", function (e) { e.target.dataset.touched = "1"; });
    document.getElementById("userForm").addEventListener("submit", create);
    document.getElementById("roleForm").addEventListener("submit", saveRole);
    render();
    renderMatrix();
    Store.on(render);
  });

  function render() { renderStrip(); renderRows(); }

  function renderStrip() {
    const users = Store.users().filter(function (u) { return u.status === "Active"; });
    const strip = document.getElementById("roleStrip");
    strip.innerHTML = "";
    Store.ROLES.forEach(function (r) {
      const n = users.filter(function (u) { return u.role === r; }).length;
      strip.appendChild(h("div", { class: "role-card" }, [h("span", { class: "icon-tile", icon: ROLE_ICON[r], iconSize: 18 }), h("div", null, [h("b", { text: String(n) }), h("span", { text: r === "Kitchen" ? "Kitchen staff" : r + (n === 1 ? "" : "s") })])]));
    });
  }

  function renderRows() {
    const all = Store.users();
    document.getElementById("userCount").textContent = all.filter(function (u) { return u.status === "Active"; }).length + " active · " + all.filter(function (u) { return u.status !== "Active"; }).length + " disabled";
    const rows = all.filter(function (u) { return !query || u.name.toLowerCase().indexOf(query) !== -1 || u.username.indexOf(query) !== -1; })
      .sort(function (a, b) { return Store.ROLES.indexOf(b.role) - Store.ROLES.indexOf(a.role) || a.name.localeCompare(b.name); });
    const body = document.getElementById("usersBody");
    body.innerHTML = "";
    rows.forEach(function (u) {
      const self = u.username === me;
      const ini = u.name.split(" ").map(function (p) { return p[0]; }).join("").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase();
      body.appendChild(h("tr", { class: u.status !== "Active" ? "dim" : "" }, [
        h("td", null, [h("div", { class: "person" }, [h("span", { class: "avatar sm", text: ini }), h("div", null, [h("b", { text: u.name + (self ? " (you)" : "") }), h("small", { class: "sub-line mono", text: "@" + u.username })])])]),
        h("td", null, [h("span", { class: "role-tag", icon: ROLE_ICON[u.role], iconSize: 14, text: u.role })]),
        h("td", null, [h("span", { class: "pill " + (u.status === "Active" ? "pill-ready" : "pill-cancelled"), text: u.status })]),
        h("td", { class: "hide-sm time", text: u.lastLogin ? CMS.dateTime(u.lastLogin) : "Never" }),
        h("td", { class: "actions" }, [h("div", { class: "row-actions" }, self ? [h("span", { class: "muted small", text: "Your account" })] : [
          h("button", { class: "btn btn-secondary btn-sm", text: "Change role", "aria-label": "Change role for " + u.name, onclick: function () { openRole(u); } }),
          h("button", { class: "btn btn-ghost btn-sm", text: u.status === "Active" ? "Disable" : "Enable", "aria-label": (u.status === "Active" ? "Disable " : "Enable ") + u.name, onclick: function () { toggle(u); } })
        ])])
      ]));
    });
  }

  function create(e) {
    e.preventDefault();
    const data = { name: document.getElementById("uName").value, username: document.getElementById("uUser").value, role: document.getElementById("uRole").value };
    const ok = CMS.attempt(function () { Store.addUser(data, me); return true; }, document.getElementById("userErr"));
    if (!ok) return;
    delete document.getElementById("uUser").dataset.touched;
    CMS.closeModal("userModal");
    CMS.toast("Account created for " + data.name.trim() + " (" + data.role + ")", "ok");
  }

  function openRole(u) {
    roleTarget = u; roleChoice = u.role;
    CMS.clearError(document.getElementById("roleErr"));
    document.getElementById("roleTitle").textContent = "Change role for " + u.name;
    document.getElementById("roleSub").textContent = "Currently " + u.role + ". They'll be signed out and must sign in again for the new role to apply.";
    renderRoleOptions();
    CMS.openModal("roleModal");
  }
  function renderRoleOptions() {
    const wrap = document.getElementById("roleOptions");
    wrap.innerHTML = "";
    Store.ROLES.forEach(function (r) {
      wrap.appendChild(h("button", { type: "button", role: "radio", class: "role-opt", "aria-checked": String(r === roleChoice), onclick: function () { roleChoice = r; renderRoleOptions(); } }, [
        h("span", { class: "icon-tile", icon: ROLE_ICON[r], iconSize: 18 }), h("div", null, [h("b", { text: r }), h("small", { text: ROLE_DESC[r] })])
      ]));
    });
  }
  async function saveRole(e) {
    e.preventDefault();
    if (roleChoice === roleTarget.role) { CMS.closeModal("roleModal"); return; }
    if (roleChoice === "Admin") {
      const ok = await CMS.confirm({ title: "Grant full admin access?", message: roleTarget.name + " will be able to manage users, roles, prices and the audit log.", okText: "Make admin", danger: true, icon: "shield" });
      if (!ok) return;
    }
    const ok = CMS.attempt(function () { Store.setRole(roleTarget.username, roleChoice, me); return true; }, document.getElementById("roleErr"));
    if (!ok) return;
    CMS.closeModal("roleModal");
    CMS.toast(roleTarget.name + " is now " + roleChoice, "ok");
  }
  async function toggle(u) {
    const disabling = u.status === "Active";
    const ok = await CMS.confirm({ title: (disabling ? "Disable " : "Enable ") + u.name + "?", message: disabling ? "They'll be signed out immediately and won't be able to sign in until re-enabled." : "They'll be able to sign in again with their existing role (" + u.role + ").", okText: disabling ? "Disable account" : "Enable account", danger: disabling, icon: disabling ? "lock" : "key" });
    if (ok && CMS.attempt(function () { Store.setStatus(u.username, disabling ? "Disabled" : "Active", me); return true; })) CMS.toast(u.name + (disabling ? " disabled" : " enabled"), "ok");
  }

  function renderMatrix() {
    const perms = [
      ["Take & update orders", ["Waiter"]], ["View table status", ["Waiter", "Cashier", "Manager", "Admin"]], ["Kitchen order queue", ["Kitchen"]],
      ["Create bills & take payments", ["Cashier", "Manager"]], ["Discounts", ["Cashier", "Manager"], { Cashier: "≤10%", Manager: "≤25%" }],
      ["Refunds", ["Manager"]], ["Inventory & restocking", ["Manager"]], ["Sales reports", ["Manager", "Admin"]],
      ["Menu & prices", ["Admin"]], ["Users & roles", ["Admin"]], ["Audit log", ["Admin"]]
    ];
    const t = document.getElementById("matrix");
    t.appendChild(h("thead", null, [h("tr", null, [h("th", { text: "Permission" })].concat(Store.ROLES.map(function (r) { return h("th", { class: "c", text: r }); })))]));
    t.appendChild(h("tbody", null, perms.map(function (p) {
      return h("tr", null, [h("td", { text: p[0] })].concat(Store.ROLES.map(function (r) {
        const yes = p[1].indexOf(r) !== -1;
        return h("td", { class: "c" }, [yes ? h("span", { class: "yes", icon: "check", iconSize: 15, text: p[2] && p[2][r] ? " " + p[2][r] : "", "aria-label": "Allowed" }) : h("span", { class: "no", text: "—", "aria-label": "Not allowed" })]);
      })));
    })));
  }
})();
