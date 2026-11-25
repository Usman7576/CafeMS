// Staff registration. The checks here are only a guide: the server validates everything again, stores
// the account as Pending, and an Admin must approve it (and choose the role) before it can sign in.
(function () {
  const form = document.getElementById("registerForm");
  const password = document.getElementById("regPassword");
  const button = document.getElementById("registerBtn");
  const alertBox = document.getElementById("formAlert");
  const RULES = {
    len: function (v) { return v.length >= 12; },
    upper: function (v) { return /[A-Z]/.test(v); },
    lower: function (v) { return /[a-z]/.test(v); },
    num: function (v) { return /[0-9]/.test(v); },
    sym: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };

  const rules = Validate.attach(form, {
    regName: { label: "Full name", required: true, min: 2, max: 60, format: "personName", collapseSpaces: true },
    regUser: { label: "Username", required: true, min: 3, max: 30, format: "username" },
    regPassword: { label: "Password", required: true, min: 12, max: 128, custom: function (v) {
      return RULES.upper(v) && RULES.lower(v) && RULES.num(v) && RULES.sym(v) ? "" : "Password needs an uppercase letter, a lowercase letter, a number and a symbol.";
    } },
    regConfirm: { label: "Confirm password", required: true, requiredMessage: "Type the password again to confirm it.", max: 128, custom: function (v, all) {
      return v === all.regPassword ? "" : "The two passwords do not match.";
    } }
  }, { summary: alertBox });
  Validate.attachStrength(password);

  function show(kind, msg) {
    alertBox.textContent = msg;
    alertBox.className = "alert show alert-" + kind;
  }

  password.addEventListener("input", function () {
    document.querySelectorAll("#pwRules li").forEach(function (li) {
      li.classList.toggle("met", RULES[li.getAttribute("data-rule")](password.value));
    });
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (button.disabled) return;
    alertBox.className = "alert";
    const checked = rules.check();
    if (!checked.ok) { alertBox.className = "alert show alert-error"; return; }
    button.disabled = true;
    try {
      const result = await Api.call("POST", "/public/register", {
        name: checked.values.regName,
        username: checked.values.regUser.toLowerCase(),
        password: password.value,
        website: document.getElementById("regWebsite").value
      }, { public: true });
      // Clear the passwords without form.reset(), which would also clear this message box
      password.value = "";
      document.getElementById("regConfirm").value = "";
      form.hidden = true;
      show("ok", result.message);
    } catch (error) {
      show("error", error.userMessage || "Something went wrong. Please try again.");
      button.disabled = false;
    }
  });
})();
