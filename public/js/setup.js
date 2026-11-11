// Invitation and reset page. The checklist is only a guide: the server enforces the password rules.
(function () {
  const match = /^#token=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  const token = match ? match[1] : "";
  // Remove the token from the address bar and history straight away
  history.replaceState(null, "", window.location.pathname);

  const form = document.getElementById("setupForm");
  const password = document.getElementById("newPassword");
  const button = document.getElementById("setupBtn");
  const alertBox = document.getElementById("formAlert");
  const RULES = {
    len: function (v) { return v.length >= 12; },
    upper: function (v) { return /[A-Z]/.test(v); },
    lower: function (v) { return /[a-z]/.test(v); },
    num: function (v) { return /[0-9]/.test(v); },
    sym: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };

  const rules = Validate.attach(form, {
    newPassword: { label: "New password", required: true, min: 12, max: 128, custom: function (v) {
      return RULES.upper(v) && RULES.lower(v) && RULES.num(v) && RULES.sym(v) ? "" : "New password needs an uppercase letter, a lowercase letter, a number and a symbol.";
    } },
    confirmPassword: { label: "Confirm password", required: true, requiredMessage: "Type the new password again to confirm it.", max: 128, custom: function (v, all) {
      return v === all.newPassword ? "" : "The two passwords do not match.";
    } }
  }, { summary: alertBox });
  Validate.attachStrength(password);

  function showError(msg) {
    alertBox.textContent = msg;
    alertBox.className = "alert show alert-error";
  }

  password.addEventListener("input", function () {
    document.querySelectorAll("#pwRules li").forEach(function (li) {
      li.classList.toggle("met", RULES[li.getAttribute("data-rule")](password.value));
    });
  });

  if (!token) {
    showError("This link is invalid or has expired. Ask an Admin for a new one.");
    button.disabled = true;
    return;
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (button.disabled) return;
    alertBox.className = "alert";
    if (!rules.check().ok) { alertBox.className = "alert show alert-error"; return; }
    button.disabled = true;
    try {
      await Api.call("POST", "/auth/setup", { token: token, password: password.value }, { public: true });
      window.location.replace("login.html#enroll");
    } catch (error) {
      showError(error.userMessage || "Something went wrong. Please try again.");
      button.disabled = false;
    }
  });
})();
