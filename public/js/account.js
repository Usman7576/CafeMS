// My account: password, recovery codes and signed-in devices. The server enforces every rule.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const RULES = {
    len: function (v) { return v.length >= 12; },
    upper: function (v) { return /[A-Z]/.test(v); },
    lower: function (v) { return /[a-z]/.test(v); },
    num: function (v) { return /[0-9]/.test(v); },
    sym: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };

  App.ready(function () {
    const next = document.getElementById("newPassword");
    next.addEventListener("input", function () {
      document.querySelectorAll("#pwRules li").forEach(function (li) { li.classList.toggle("met", RULES[li.getAttribute("data-rule")](next.value)); });
    });
    document.getElementById("passwordForm").addEventListener("submit", changePassword);
    document.getElementById("newCodes").addEventListener("click", newCodes);
    loadStatus();
    loadDevices();
  });

  async function loadStatus() {
    const me = await CMS.attempt(function () { return Api.me(); });
    if (me) document.getElementById("mfaStatus").textContent = "On · " + me.recoveryCodesLeft + " recovery code" + (me.recoveryCodesLeft === 1 ? "" : "s") + " left";
  }

  async function changePassword(e) {
    e.preventDefault();
    const err = document.getElementById("passwordErr");
    CMS.clearError(err);
    const body = { currentPassword: document.getElementById("currentPassword").value, newPassword: document.getElementById("newPassword").value };
    await CMS.busy(document.getElementById("passwordSave"), async function () {
      const ok = await CMS.attempt(async function () { await Api.call("POST", "/auth/password", body); return true; }, err);
      if (!ok) return;
      e.target.reset();
      document.querySelectorAll("#pwRules li").forEach(function (li) { li.classList.remove("met"); });
      CMS.toast("Password changed. Your other devices were signed out.", "ok");
      loadDevices();
    });
  }

  async function newCodes(e) {
    const ok = await CMS.confirm({ title: "Make new recovery codes?", message: "Your current recovery codes will stop working.", okText: "Make new codes", icon: "key" });
    if (!ok) return;
    await CMS.busy(e.target, async function () {
      const result = await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("POST", "/auth/mfa/recovery-codes", {}); }); });
      if (!result) return;
      const list = document.getElementById("recoveryList");
      list.replaceChildren.apply(list, result.recoveryCodes.map(function (c) { return h("li", { text: c }); }));
      list.hidden = false;
      document.getElementById("recoveryActions").replaceChildren(CMS.codeActions(result.recoveryCodes));
      CMS.toast("Save these codes now. They are shown only once.", "info");
      loadStatus();
    });
  }

  async function loadDevices() {
    const result = await CMS.attempt(function () { return Api.call("GET", "/auth/sessions"); });
    if (!result) return;
    const list = document.getElementById("deviceList");
    list.replaceChildren();
    result.sessions.forEach(function (s) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno " + (s.current ? "ok" : ""), icon: "server", iconSize: 18 }),
        h("div", { class: "meta" }, [
          h("b", { text: s.current ? "This device" : "Another device" }),
          h("small", { text: s.userAgent || "Unknown browser" }),
          h("small", { text: (s.ip || "Unknown address") + " · last active " + CMS.timeAgo(Date.parse(s.lastSeenAt)) })
        ]),
        s.current ? null : h("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Sign out", onclick: function () { revoke(s); } })
      ]));
    });
  }

  async function revoke(s) {
    const ok = await CMS.attempt(async function () { await Api.call("DELETE", "/auth/sessions/" + encodeURIComponent(s.id)); return true; });
    if (ok) { CMS.toast("That device was signed out.", "ok"); loadDevices(); }
  }
})();
