// Staff sign-in screens. These only display steps: the server makes every decision, including
// password and code checks, lockout and the user's role.
(function () {
  const HOME = { Waiter: "dashboard.html", Kitchen: "kitchen.html", Cashier: "billing.html", Manager: "overview.html", Admin: "overview.html" };
  const el = function (id) { return document.getElementById(id); };
  const STEPS = ["stepPassword", "stepMfa", "stepEnroll", "stepRecovery"];
  const alertBox = el("formAlert");
  const password = el("password");
  const loginBtn = el("loginBtn");
  let recoveryMode = false;

  function showStep(id) {
    STEPS.forEach(function (s) { el(s).hidden = s !== id; });
    hideAlert();
    const input = el(id).querySelector("input");
    if (input) input.focus();
  }
  function showAlert(msg, type) {
    alertBox.replaceChildren();
    alertBox.className = "alert show alert-" + (type || "error");
    alertBox.prepend(Icons.node(type === "info" ? "info" : "alert", 18));
    alertBox.appendChild(CMS.h("span", { text: msg }));
  }
  function hideAlert() { alertBox.className = "alert"; }
  function errorText(e) { return e.userMessage || "Something went wrong. Please try again."; }

  // Prevents double submission while a request is in flight
  async function busy(button, work) {
    if (button.disabled) return;
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }

  async function enterWorkspace() {
    const me = await Api.me();
    Session.set({ user: me.username, name: me.name, role: me.role, loginAt: me.loginAt });
    // Straight after signing in, this device can register its signing key without another code
    await Signer.ensure(me.username).catch(function () { /* set up on first signed action instead */ });
    window.location.replace(HOME[me.role]);
  }

  // ---------- Step 1: password ----------
  function afterPassword(result) {
    if (result.next === "mfa") { setRecoveryMode(false); showStep("stepMfa"); return Promise.resolve(); }
    return startEnrolment();
  }

  el("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const username = el("username").value.trim();
    if (!username || !password.value) { showAlert("Enter your username and password."); return; }
    busy(loginBtn, async function () {
      try {
        const result = await Api.call("POST", "/auth/login", { username: username, password: password.value }, { public: true });
        await afterPassword(result);
      } catch (error) {
        showAlert(errorText(error));
      } finally {
        password.value = "";
      }
    });
  });

  // ---------- Step 2: authenticator or recovery code ----------
  function setRecoveryMode(on) {
    recoveryMode = on;
    el("mfaLabel").textContent = on ? "Recovery code" : "Authenticator code";
    el("mfaHint").textContent = on ? "Enter one of the recovery codes you saved. Each works only once." : "Open your authenticator app and enter the 6-digit code for CafeMS.";
    el("useRecovery").textContent = on ? "Use my authenticator app" : "Lost your phone? Use a recovery code";
    el("mfaCode").value = "";
  }
  el("useRecovery").addEventListener("click", function () { setRecoveryMode(!recoveryMode); el("mfaCode").focus(); });

  el("mfaForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const value = el("mfaCode").value.trim();
    if (!value) { showAlert("Enter your code."); return; }
    busy(el("mfaBtn"), async function () {
      try {
        await Api.call("POST", "/auth/mfa/verify", recoveryMode ? { recoveryCode: value } : { code: value }, { public: true });
        await enterWorkspace();
      } catch (error) {
        el("mfaCode").value = "";
        if (error.code === "challenge_expired") { showStep("stepPassword"); }
        showAlert(errorText(error));
      }
    });
  });

  // ---------- First sign-in: add an authenticator ----------
  async function startEnrolment() {
    const data = await Api.call("POST", "/auth/mfa/enroll/start", {}, { public: true });
    el("enrollQr").src = data.qrDataUrl;
    el("enrollKey").textContent = data.manualKey;
    showStep("stepEnroll");
  }

  el("enrollForm").addEventListener("submit", function (e) {
    e.preventDefault();
    const code = el("enrollCode").value.trim();
    if (!code) { showAlert("Enter the 6-digit code from your app."); return; }
    busy(el("enrollBtn"), async function () {
      try {
        const result = await Api.call("POST", "/auth/mfa/enroll/confirm", { code: code }, { public: true });
        const list = el("recoveryList");
        result.recoveryCodes.forEach(function (c) { list.appendChild(CMS.h("li", { text: c })); });
        el("recoveryActions").replaceChildren(CMS.codeActions(result.recoveryCodes));
        showStep("stepRecovery");
      } catch (error) {
        el("enrollCode").value = "";
        if (error.code === "challenge_expired") { showStep("stepPassword"); }
        showAlert(errorText(error));
      }
    });
  });

  el("copyKey").addEventListener("click", function () { CMS.copyText(el("enrollKey").textContent, "Key copied"); });
  el("recoverySaved").addEventListener("change", function (e) { el("recoveryDone").disabled = !e.target.checked; });
  el("recoveryDone").addEventListener("click", function () {
    busy(el("recoveryDone"), function () { return enterWorkspace().catch(function (error) { showAlert(errorText(error)); }); });
  });

  // ---------- Small conveniences ----------
  el("togglePw").addEventListener("click", function () {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    el("togglePw").replaceChildren(Icons.node(show ? "eye-off" : "eye", 18));
    el("togglePw").setAttribute("aria-label", show ? "Hide password" : "Show password");
    el("togglePw").setAttribute("aria-pressed", String(show));
    password.focus();
  });
  ["keydown", "keyup"].forEach(function (ev) {
    password.addEventListener(ev, function (e) { if (e.getModifierState) el("capsWarn").classList.toggle("show", e.getModifierState("CapsLock")); });
  });
  password.addEventListener("blur", function () { el("capsWarn").classList.remove("show"); });
  el("forgotLink").addEventListener("click", function (e) { e.preventDefault(); CMS.openModal("forgotModal"); });

  // ---------- On load ----------
  (async function () {
    const flash = Session.flash();
    if (window.location.hash === "#enroll") {
      history.replaceState(null, "", window.location.pathname);
      try { await startEnrolment(); } catch (error) { showAlert(errorText(error)); }
    } else {
      try {
        await enterWorkspace();
        return;
      } catch (error) {
        Session.clear();
      }
    }
    if (flash) showAlert(flash, "info");
    // The button ships disabled so the form can't be submitted before this script is ready
    loginBtn.disabled = false;
  })();
})();
