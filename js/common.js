// Shared helpers used on every page.
(function () {
  // ---------- DOM helper: builds elements with textContent only (no innerHTML for data) ----------
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text" || k === "icon" || k === "iconSize") return;
        else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
      if (attrs.text !== undefined) el.textContent = attrs.text;
      if (attrs.icon) el.insertAdjacentHTML("afterbegin", Icons.svg(attrs.icon, attrs.iconSize || 16));
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  // ---------- Formatting ----------
  const money = function (n) { return "Rs " + Math.round(n).toLocaleString("en-PK"); };
  const timeAgo = function (ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return (m || 1) + " min ago";
    return Math.floor(m / 60) + " h ago";
  };
  const clock = function (d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

  // ---------- Toasts ----------
  function toast(message, type) {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
      document.body.appendChild(stack);
    }
    const icon = type === "err" ? "alert" : type === "info" ? "bell" : "check-circle";
    const t = h("div", { class: "toast " + (type || "ok"), icon: icon, iconSize: 18 }, [h("span", { text: message })]);
    stack.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  // ---------- Modal: open/close with focus handling and Escape ----------
  let lastFocus = null;
  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    lastFocus = document.activeElement;
    m.classList.add("show");
    const target = m.querySelector("[data-autofocus]") || m.querySelector("button");
    if (target) target.focus();
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    m.classList.remove("show");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".modal-backdrop.show:not([data-static])");
    if (open) closeModal(open.id);
  });
  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("modal-backdrop") && !e.target.hasAttribute("data-static")) {
      closeModal(e.target.id);
    }
    const closer = e.target.closest && e.target.closest("[data-close]");
    if (closer) closeModal(closer.getAttribute("data-close"));
  });

  // Promise-based confirm dialog (replaces window.confirm)
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      const id = "confirm-" + Date.now();
      const okBtn = h("button", { class: "btn " + (opts.danger ? "btn-danger" : "btn-primary"), text: opts.okText || "Confirm", "data-autofocus": true });
      const cancelBtn = h("button", { class: "btn btn-secondary", text: opts.cancelText || "Cancel" });
      const backdrop = h("div", { class: "modal-backdrop", id: id, role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t" }, [
        h("div", { class: "modal" }, [
          h("div", { class: "modal-head" }, [
            h("div", { class: "icon-tile " + (opts.danger ? "danger" : "warn"), icon: opts.icon || "alert", iconSize: 20 }),
            h("div", null, [h("h3", { id: id + "-t", text: opts.title }), opts.message ? h("p", { text: opts.message }) : null])
          ]),
          h("div", { class: "modal-actions" }, [cancelBtn, okBtn])
        ])
      ]);
      document.body.appendChild(backdrop);
      const done = function (v) { closeModal(id); backdrop.remove(); resolve(v); };
      okBtn.addEventListener("click", function () { done(true); });
      cancelBtn.addEventListener("click", function () { done(false); });
      backdrop.addEventListener("click", function (e) { if (e.target === backdrop) done(false); });
      backdrop.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      openModal(id);
    });
  }

  // ---------- Session (prototype only) ----------
  // The real system will use a server-issued session / JWT in an HttpOnly cookie.
  // Nothing stored here is trusted; the backend will enforce authentication and RBAC.
  const Session = {
    KEY: "cms_session",
    get: function () { try { return JSON.parse(sessionStorage.getItem(this.KEY)); } catch (e) { return null; } },
    set: function (d) { try { sessionStorage.setItem(this.KEY, JSON.stringify(d)); } catch (e) {} },
    clear: function () { try { sessionStorage.removeItem(this.KEY); } catch (e) {} },
    flash: function (msg) {
      try {
        if (msg === undefined) { const m = sessionStorage.getItem("cms_flash"); sessionStorage.removeItem("cms_flash"); return m; }
        sessionStorage.setItem("cms_flash", msg);
      } catch (e) { return null; }
    }
  };

  // ---------- Public-site nav toggle + footer year ----------
  document.addEventListener("DOMContentLoaded", function () {
    const toggle = document.querySelector(".nav-toggle");
    const links = document.querySelector(".site-nav .links");
    if (toggle && links) {
      toggle.addEventListener("click", function () {
        const open = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
      });
      links.addEventListener("click", function (e) {
        if (e.target.closest("a")) { links.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
      });
    }
    document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
  });

  window.CMS = { h: h, money: money, timeAgo: timeAgo, clock: clock, toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog };
  window.Session = Session;
})();
