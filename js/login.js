// Login page: validation, show/hide password, simulated lockout.
(function () {
  const form = document.getElementById("loginForm");
  const username = document.getElementById("username");
  const password = document.getElementById("password");
  const togglePw = document.getElementById("togglePw");
  const alertBox = document.getElementById("formAlert");
  const loginBtn = document.getElementById("loginBtn");

  const MAX_ATTEMPTS = 5;
  const LOCK_SECONDS = 30;
  let failedAttempts = 0;

  // If already signed in, go straight to the order page
  if (Session.get()) {
    window.location.href = "order.html";
    return;
  }

  try {
    const msg = sessionStorage.getItem("cms_logout_msg");
    if (msg) {
      alertBox.textContent = msg;
      alertBox.className = "alert show alert-info";
      sessionStorage.removeItem("cms_logout_msg");
    }
  } catch (e) {}

  // Interaction 1: show / hide password
  togglePw.addEventListener("click", function () {
    const hidden = password.type === "password";
    password.type = hidden ? "text" : "password";
    togglePw.textContent = hidden ? "Hide" : "Show";
    togglePw.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
  });

  function setError(input, id, msg) {
    document.getElementById(id).textContent = msg;
    input.classList.toggle("invalid", !!msg);
  }

  function validateUsername() {
    const v = username.value.trim();
    if (!v) return setError(username, "usernameError", "Username is required."), false;
    if (!/^[a-zA-Z0-9._]{3,30}$/.test(v)) {
      return setError(username, "usernameError", "3–30 characters: letters, numbers, dot or underscore."), false;
    }
    setError(username, "usernameError", "");
    return true;
  }

  function validatePassword() {
    const v = password.value;
    if (!v) return setError(password, "passwordError", "Password is required."), false;
    if (v.length < 8 || !/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v)) {
      return setError(password, "passwordError", "Password doesn't meet the rules below."), false;
    }
    setError(password, "passwordError", "");
    return true;
  }

  username.addEventListener("blur", validateUsername);
  password.addEventListener("blur", validatePassword);

  function showAlert(msg, type) {
    alertBox.textContent = msg;
    alertBox.className = "alert show " + (type === "info" ? "alert-info" : "alert-error");
  }

  function lockForm() {
    let remaining = LOCK_SECONDS;
    loginBtn.disabled = true;
    const tick = function () {
      showAlert("Too many failed attempts. Try again in " + remaining + "s.");
      loginBtn.textContent = "Locked (" + remaining + "s)";
      if (remaining-- <= 0) {
        clearInterval(timer);
        failedAttempts = 0;
        loginBtn.disabled = false;
        loginBtn.textContent = "Sign in";
        alertBox.className = "alert";
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
  }

  // Interaction 2: form validation on submit
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const okUser = validateUsername();
    const okPass = validatePassword();

    if (!okUser || !okPass) {
      failedAttempts++;
      if (failedAttempts >= MAX_ATTEMPTS) {
        lockForm();
      } else {
        // Generic message: never say which field was wrong on a real failed login
        showAlert("Please fix the highlighted fields. (" + (MAX_ATTEMPTS - failedAttempts) + " attempts left)");
      }
      return;
    }

    // Prototype: simulate server-issued session. Password is never stored.
    Session.set({ user: username.value.trim(), role: "Waiter", loginAt: Date.now() });
    password.value = "";
    window.location.href = "order.html";
  });

  document.getElementById("forgotLink").addEventListener("click", function (e) {
    e.preventDefault();
    showAlert("Please ask your manager or admin to reset your password.", "info");
  });
})();
