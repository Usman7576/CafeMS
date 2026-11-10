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
    document.getElementById("addPasskey").addEventListener("click", addPasskey);
    document.getElementById("questionForm").addEventListener("submit", saveQuestion);
    if (!(window.PublicKeyCredential && window.SimpleWebAuthnBrowser)) document.getElementById("addPasskey").disabled = true;
    loadStatus();
    loadDevices();
    loadPasskeys();
    loadQuestion();
    loadOidc();
  });

  async function loadOidc() {
    const result = await Api.call("GET", "/auth/oidc/enabled").catch(function () { return null; });
    if (!result || !result.enabled) return;
    document.getElementById("oidcPanel").hidden = false;
    if (window.location.hash === "#oidc-linked") { history.replaceState(null, "", window.location.pathname); CMS.toast("Organisation account linked", "ok"); }
    document.getElementById("oidcLinkBtn").addEventListener("click", function (e) {
      CMS.busy(e.currentTarget, async function () {
        const r = await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("POST", "/auth/oidc/link", {}); }); });
        if (r && r.url) window.location.assign(r.url);
      });
    });
    document.getElementById("oidcUnlinkBtn").addEventListener("click", function (e) {
      CMS.busy(e.currentTarget, async function () {
        const ok = await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("POST", "/auth/oidc/unlink", {}); }).then(function () { return true; }); });
        if (ok) CMS.toast("Organisation account unlinked", "ok");
      });
    });
  }

  async function loadPasskeys() {
    const result = await CMS.attempt(function () { return Api.call("GET", "/auth/passkeys"); });
    if (!result) return;
    const list = document.getElementById("passkeyList");
    list.replaceChildren();
    if (!result.passkeys.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "No passkeys yet." })])); return; }
    result.passkeys.forEach(function (p) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno ok", icon: "key", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: p.label }), h("small", { text: p.lastUsedAt ? "Last used " + CMS.timeAgo(p.lastUsedAt) : "Not used yet" })]),
        h("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Remove", onclick: function (e) {
          CMS.busy(e.currentTarget, async function () {
            const ok = await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("DELETE", "/auth/passkeys/" + encodeURIComponent(p.id)); }).then(function () { return true; }); });
            if (ok) { CMS.toast("Passkey removed", "ok"); loadPasskeys(); }
          });
        } })
      ]));
    });
  }

  // The device asks for a fingerprint, face or PIN, then makes a key that works only for this site
  async function addPasskey(e) {
    await CMS.busy(e.currentTarget, async function () {
      const ok = await CMS.attempt(function () {
        return CMS.withStepUp(async function () {
          const options = await Api.call("POST", "/auth/passkeys/register/options", {});
          const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
          const label = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "This device").slice(0, 40) + " passkey";
          await Api.call("POST", "/auth/passkeys", { response: response, label: label });
          return true;
        });
      });
      if (ok) { CMS.toast("Passkey added", "ok"); loadPasskeys(); }
    });
  }

  async function loadQuestion() {
    const result = await CMS.attempt(function () { return Api.call("GET", "/auth/security-question"); });
    if (result && result.question) document.getElementById("questionStatus").textContent = "Set: " + result.question;
  }

  async function saveQuestion(e) {
    e.preventDefault();
    const body = { question: document.getElementById("questionText").value.trim(), answer: document.getElementById("questionAnswer").value.trim() };
    await CMS.busy(document.getElementById("questionSave"), async function () {
      const ok = await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("POST", "/auth/security-question", body); }).then(function () { return true; }); });
      if (ok) {
        document.getElementById("questionForm").reset();
        CMS.toast("Security question saved", "ok");
        loadQuestion();
      }
    });
  }

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
          h("small", { text: (s.ip || "Unknown address") + (s.country ? " (" + s.country + ")" : "") + " · last active " + CMS.timeAgo(Date.parse(s.lastSeenAt)) })
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
