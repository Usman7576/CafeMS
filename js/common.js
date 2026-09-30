// Shared helpers used on every page.

// Mobile navigation toggle
document.addEventListener("DOMContentLoaded", function () {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  const year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
});

// Small toast notification
function showToast(message, type) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message; // textContent, never innerHTML, for user-facing text
  toast.className = "toast show " + (type || "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () {
    toast.className = "toast " + (type || "");
  }, 3000);
}

// Prototype-only session helpers. The real system will use a server-issued
// session / JWT in an HttpOnly cookie; nothing here is a security control.
const Session = {
  KEY: "cms_session",
  get: function () {
    try { return JSON.parse(sessionStorage.getItem(this.KEY)); } catch (e) { return null; }
  },
  set: function (data) {
    try { sessionStorage.setItem(this.KEY, JSON.stringify(data)); } catch (e) {}
  },
  clear: function () {
    try { sessionStorage.removeItem(this.KEY); } catch (e) {}
  }
};
