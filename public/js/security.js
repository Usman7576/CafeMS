// Admin security page: pending approvals, locked accounts and high-severity events.
(function () {
  if (!window.App) return;
  const h = CMS.h;

  App.ready(function () {
    render();
    Store.on(render);
    document.getElementById("eraseForm").addEventListener("submit", erase);
    loadEvents();
    setInterval(loadEvents, 30000);
  });

  async function erase(e) {
    e.preventDefault();
    const input = document.getElementById("erasePhone"), err = document.getElementById("eraseErr");
    CMS.clearError(err);
    const phone = input.value.trim();
    const ok = await CMS.confirm({ title: "Erase this customer's data?", message: "Their number, name and notes are removed from all bills and reservations. This cannot be undone.", okText: "Erase data", danger: true, icon: "trash" });
    if (!ok) return;
    const result = await CMS.attempt(function () { return CMS.withStepUp(function () { return Store.eraseCustomer(phone); }); }, err);
    if (!result) return;
    input.value = "";
    CMS.toast("Erased from " + result.bills + " bills and " + result.reservations + " reservations.", "ok");
  }

  function renderAlerts() {
    const list = document.getElementById("alertList");
    list.replaceChildren();
    const alerts = Store.alerts();
    if (!alerts.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "No open alerts." })])); return; }
    alerts.forEach(function (a) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno " + (a.severity === "high" ? "danger" : "warn"), icon: "alert", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: a.title }), h("small", { text: a.details + " · " + CMS.timeAgo(a.lastSeenAt) })]),
        h("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Acknowledge", onclick: function (e) {
          const button = e.currentTarget;
          CMS.busy(button, function () { return CMS.attempt(function () { return Store.acknowledgeAlert(a.id); }); });
        } })
      ]));
    });
  }

  function render() {
    renderAlerts();
    CMS.renderApprovals(document.getElementById("approvalList"));
    const list = document.getElementById("lockedList");
    list.replaceChildren();
    const locked = Store.users().filter(function (u) { return u.locked; });
    if (!locked.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "No accounts are locked." })])); return; }
    locked.forEach(function (u) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno warn", icon: "lock", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: u.name }), h("small", { text: "@" + u.username + " · " + u.role })]),
        h("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Unlock", onclick: function () { unlock(u); } })
      ]));
    });
  }

  async function unlock(u) {
    const ok = await CMS.attempt(async function () { await CMS.withStepUp(function () { return Store.unlockUser(u.username); }); return true; });
    if (ok) CMS.toast(u.name + " unlocked", "ok");
  }

  async function loadEvents() {
    const entries = await CMS.attempt(function () { return Store.auditEntries("high"); });
    if (!entries) return;
    const list = document.getElementById("securityEvents");
    list.replaceChildren();
    if (!entries.length) { list.appendChild(h("li", { class: "more" }, [h("span", { class: "muted", text: "No high-severity events." })])); return; }
    entries.slice(0, 25).forEach(function (e) {
      list.appendChild(h("li", { class: "sev-high" }, [h("span", { class: "dot" }), h("div", null, [
        h("b", { text: e.action }), h("span", { text: e.details }), h("small", { text: e.actor + " · " + CMS.timeAgo(e.at) + (e.ip ? " · " + e.ip : "") })
      ])]));
    });
  }
})();
