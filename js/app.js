// App shell for signed-in staff pages: session guard, sidebar, top bar,
// notifications, user menu and inactivity timeout.
(function () {
  const session = Session.get();
  if (!session) {
    // UX redirect only — real access control will be enforced by the backend (SR-3).
    document.documentElement.style.visibility = "hidden";
    Session.flash("Please sign in to continue.");
    window.location.replace("login.html");
    return; // page scripts check window.App and do nothing without a session
  }

  Store.init(session.user);

  const $ = function (s) { return document.querySelector(s); };

  function signOut(msg) {
    Session.clear();
    try { sessionStorage.removeItem("cms_orders"); } catch (e) {}
    if (msg) Session.flash(msg);
    window.location.replace("login.html");
  }

  document.addEventListener("DOMContentLoaded", function () {
    // ----- User identity -----
    const initials = session.name.split(" ").map(function (p) { return p[0]; }).join("").slice(0, 2).toUpperCase();
    document.querySelectorAll("[data-user-name]").forEach(function (el) { el.textContent = session.name; });
    document.querySelectorAll("[data-user-role]").forEach(function (el) { el.textContent = session.role; });
    document.querySelectorAll("[data-user-initials]").forEach(function (el) { el.textContent = initials; });
    document.querySelectorAll("[data-user-handle]").forEach(function (el) { el.textContent = "@" + session.user; });

    // ----- Shift clock -----
    const clockEl = $("#shiftClock");
    const since = CMS.clock(new Date(session.loginAt));
    function tickClock() { if (clockEl) clockEl.textContent = CMS.clock(new Date()) + " · on shift since " + since; }
    tickClock(); setInterval(tickClock, 15000);

    // ----- Mobile sidebar -----
    const sidebar = $(".sidebar"), scrim = $(".scrim"), menuBtn = $(".menu-btn");
    function setSidebar(open) {
      sidebar.classList.toggle("open", open);
      scrim.classList.toggle("show", open);
      menuBtn.setAttribute("aria-expanded", String(open));
    }
    if (menuBtn) menuBtn.addEventListener("click", function () { setSidebar(!sidebar.classList.contains("open")); });
    if (scrim) scrim.addEventListener("click", function () { setSidebar(false); });
    sidebar.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", function () { setSidebar(false); }); });

    // ----- Dropdowns (user menu + notifications) -----
    function bindDropdown(btnSel, menuSel) {
      const btn = $(btnSel), menu = $(menuSel);
      if (!btn || !menu) return;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const open = !menu.classList.contains("open");
        document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); });
        menu.classList.toggle("open", open);
        btn.setAttribute("aria-expanded", String(open));
      });
    }
    bindDropdown("#userBtn", "#userMenu");
    bindDropdown("#notifBtn", "#notifMenu");
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".dropdown")) document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { document.querySelectorAll(".dropdown.open").forEach(function (d) { d.classList.remove("open"); }); setSidebar(false); }
    });

    // ----- Sign out -----
    document.querySelectorAll("[data-signout]").forEach(function (b) {
      b.addEventListener("click", async function () {
        const ok = await CMS.confirm({ title: "Sign out?", message: "You'll need to sign in again to take orders.", okText: "Sign out", icon: "logout" });
        if (ok) signOut("You have been signed out.");
      });
    });

    // ----- Notifications: orders ready to serve -----
    function renderNotifs() {
      const ready = Store.byStatus("Ready");
      const n = ready.length ? String(ready.length) : "";
      document.querySelectorAll("[data-ready-count]").forEach(function (el) { el.textContent = n; });
      const list = $("#notifList");
      if (!list) return;
      list.innerHTML = "";
      if (!ready.length) { list.appendChild(CMS.h("div", { class: "notif-empty", text: "No orders waiting to be served." })); return; }
      ready.forEach(function (o) {
        list.appendChild(CMS.h("div", { class: "notif-item", icon: "bell", iconSize: 16 }, [
          CMS.h("span", null, [CMS.h("b", { text: o.id }), " for Table " + o.table + " is ready to serve"])
        ]));
      });
    }
    renderNotifs();
    Store.on(function (changed) {
      renderNotifs();
      changed.forEach(function (o) {
        if (o.status === "Ready") CMS.toast(o.id + " for Table " + o.table + " is ready to serve", "info");
      });
    });

    // ----- Inactivity timeout with warning (SR-6) -----
    const IDLE_MS = 5 * 60 * 1000, WARN_MS = 30 * 1000;
    let idleTimer, countdown, warned = false;
    const warnModal = $("#idleModal"), warnCount = $("#idleCount");
    function reset() {
      if (warned) return; // once the warning is showing, only the button keeps the session alive
      clearTimeout(idleTimer);
      idleTimer = setTimeout(warn, IDLE_MS - WARN_MS);
    }
    function warn() {
      warned = true;
      let left = WARN_MS / 1000;
      warnCount.textContent = left;
      CMS.openModal("idleModal");
      countdown = setInterval(function () {
        left--; warnCount.textContent = left;
        if (left <= 0) { clearInterval(countdown); signOut("You were signed out after 5 minutes of inactivity."); }
      }, 1000);
    }
    $("#staySignedIn").addEventListener("click", function () {
      clearInterval(countdown); warned = false; CMS.closeModal("idleModal"); reset();
    });
    ["mousemove", "keydown", "click", "touchstart", "scroll"].forEach(function (ev) {
      document.addEventListener(ev, reset, { passive: true });
    });
    reset();
    if (warnModal) warnModal.setAttribute("data-static", "");
  });

  window.App = { session: session, signOut: signOut };
})();
