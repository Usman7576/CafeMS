// Staff sign-in: validation, password visibility, Caps Lock warning,
// password-rule checklist, lockout after repeated failures, audit logging.
// The role always comes from the user directory ("server"), never from this form.
(function () {
  const HOME = { Waiter: "dashboard.html", Kitchen: "kitchen.html", Cashier: "billing.html", Manager: "overview.html", Admin: "overview.html" };
  Store.init();

  const existing = Session.get();
  if (existing && HOME[existing.role]) { window.location.replace(HOME[existing.role]); return; }

  const form = document.getElementById("loginForm");
  const username = document.getElementById("username");
  const password = document.getElementById("password");
  const togglePw = document.getElementById("togglePw");
  const alertBox = document.getElementById("formAlert");
  const loginBtn = document.getElementById("loginBtn");
  const capsWarn = document.getElementById("capsWarn");
  const rulesEl = document.getElementById("pwRules");

  const MAX_ATTEMPTS = 5;
  const LOCK_SECONDS = 30;
  const LOCK_KEY = "cms_lock_until";
  let failed = 0;

  function showAlert(msg, type) {
    alertBox.innerHTML = "";
    alertBox.className = "alert show alert-" + (type || "error");
    alertBox.insertAdjacentHTML("afterbegin", Icons.svg(type === "info" ? "info" : "alert", 18));
    alertBox.appendChild(CMS.h("span", { text: msg }));
  }
  function hideAlert() { alertBox.className = "alert"; }

  const flash = Session.flash();
  if (flash) showAlert(flash, "info");

  // ----- Demo accounts (prototype only): fills the username, never the password -----
  const DEMO = [
    { u: "m.usman", role: "Waiter", note: "Primary role" }, { u: "chef.imran", role: "Kitchen" }, { u: "bilal.ahmed", role: "Cashier" },
    { u: "sara.khan", role: "Manager" }, { u: "farah.admin", role: "Admin" }
  ];
  const demoWrap = document.getElementById("demoAccounts");
  if (demoWrap) {
    DEMO.forEach(function (d) {
      demoWrap.appendChild(CMS.h("button", { type: "button", class: "demo-chip", "aria-label": "Use " + d.role + " demo account " + d.u, onclick: function () {
        username.value = d.u;
        setError(username, "usernameError", "");
        demoWrap.querySelectorAll(".demo-chip").forEach(function (c) { c.classList.toggle("active", c === this); }, this);
        password.focus();
      } }, [CMS.h("b", { text: d.role }), CMS.h("span", { text: d.u })]));
    });
  }

  // ----- Interaction: show / hide password -----
  togglePw.addEventListener("click", function () {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    togglePw.innerHTML = Icons.svg(show ? "eye-off" : "eye", 18);
    togglePw.setAttribute("aria-label", show ? "Hide password" : "Show password");
    togglePw.setAttribute("aria-pressed", String(show));
    password.focus();
  });

  // ----- Interaction: Caps Lock warning -----
  ["keydown", "keyup"].forEach(function (ev) {
    password.addEventListener(ev, function (e) { if (e.getModifierState) capsWarn.classList.toggle("show", e.getModifierState("CapsLock")); });
  });
  password.addEventListener("blur", function () { capsWarn.classList.remove("show"); });

  // ----- Interaction: live password-rule checklist -----
  const RULES = {
    len: function (v) { return v.length >= 8; },
    upper: function (v) { return /[A-Z]/.test(v); },
    lower: function (v) { return /[a-z]/.test(v); },
    num: function (v) { return /[0-9]/.test(v); }
  };
  function checkRules() {
    const v = password.value;
    let all = true;
    rulesEl.querySelectorAll("li").forEach(function (li) {
      const ok = RULES[li.getAttribute("data-rule")](v);
      li.classList.toggle("met", ok);
      if (!ok) all = false;
    });
    return all;
  }
  password.addEventListener("input", function () { checkRules(); if (password.classList.contains("invalid")) validatePassword(); });

  // ----- Interaction: form validation -----
  function setError(input, id, msg) {
    const el = document.getElementById(id);
    el.innerHTML = "";
    if (msg) { el.insertAdjacentHTML("afterbegin", Icons.svg("alert", 14)); el.appendChild(CMS.h("span", { text: msg })); }
    input.classList.toggle("invalid", !!msg);
    input.setAttribute("aria-invalid", msg ? "true" : "false");
  }
  function validateUsername() {
    const v = username.value.trim();
    if (!v) { setError(username, "usernameError", "Enter your username."); return false; }
    if (!/^[a-zA-Z][a-zA-Z0-9._]{2,29}$/.test(v)) { setError(username, "usernameError", "Use 3–30 letters, numbers, dots or underscores, starting with a letter."); return false; }
    setError(username, "usernameError", "");
    return true;
  }
  function validatePassword() {
    if (!password.value) { setError(password, "passwordError", "Enter your password."); return false; }
    if (!checkRules()) { setError(password, "passwordError", "Password doesn't meet all the requirements below."); return false; }
    setError(password, "passwordError", "");
    return true;
  }
  username.addEventListener("blur", function () { if (username.value) validateUsername(); });
  username.addEventListener("input", function () { if (username.classList.contains("invalid")) validateUsername(); });

  // ----- Lockout (SR-6). Real lockout is enforced per account on the server. -----
  function lockedUntil() { try { return parseInt(sessionStorage.getItem(LOCK_KEY), 10) || 0; } catch (e) { return 0; } }
  function startLock(until) {
    try { sessionStorage.setItem(LOCK_KEY, String(until)); } catch (e) {}
    loginBtn.disabled = true;
    const tick = function () {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer);
        try { sessionStorage.removeItem(LOCK_KEY); } catch (e) {}
        failed = 0; loginBtn.disabled = false; loginBtn.textContent = "Sign in"; hideAlert();
        return;
      }
      showAlert("Too many failed attempts. For your security, sign-in is paused for " + left + " seconds.");
      loginBtn.textContent = "Try again in " + left + "s";
    };
    const timer = setInterval(tick, 1000);
    tick();
  }

  function registerFailure(msg, auditUser, auditDetail) {
    failed++;
    if (auditUser) Store.log(auditUser, "Sign-in failed", auditDetail, "warning");
    if (failed >= MAX_ATTEMPTS) {
      Store.log(auditUser || null, "Sign-in locked", MAX_ATTEMPTS + " failed attempts on this device", "high");
      startLock(Date.now() + LOCK_SECONDS * 1000);
      return;
    }
    const left = MAX_ATTEMPTS - failed;
    showAlert(msg + " " + left + " attempt" + (left === 1 ? "" : "s") + " left before sign-in is paused.");
  }

  // The button ships disabled so the form can't be submitted before this script is ready.
  loginBtn.disabled = false;
  if (lockedUntil() > Date.now()) startLock(lockedUntil());

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (loginBtn.disabled) return;
    const okU = validateUsername();
    const okP = validatePassword();
    if (!okU || !okP) {
      registerFailure("Sign-in failed. Check the highlighted fields.");
      (okU ? password : username).focus();
      return;
    }

    const name = username.value.trim().toLowerCase();
    const user = Store.findUser(name);
    password.value = "";
    checkRules();
    if (!user || user.status !== "Active") {
      // Generic message: never reveal whether the username exists (prevents account enumeration)
      registerFailure("Incorrect username or password.", name, user ? "Disabled account" : "Unknown username");
      password.focus();
      return;
    }

    loginBtn.disabled = true;
    loginBtn.innerHTML = "";
    loginBtn.append(CMS.h("span", { class: "spinner", "aria-hidden": "true" }), "Signing in…");
    setTimeout(function () {
      Store.recordLogin(user.username);
      Session.set({ user: user.username, name: user.name, role: user.role, loginAt: Date.now() });
      window.location.href = HOME[user.role];
    }, 500);
  });

  document.getElementById("forgotLink").addEventListener("click", function (e) { e.preventDefault(); CMS.openModal("forgotModal"); });
})();
