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

    // Landing page: if already signed in, "Staff sign in" buttons open the user's workspace instead
    const s = Session.get();
    const HOME = { Waiter: "dashboard.html", Kitchen: "kitchen.html", Cashier: "billing.html", Manager: "overview.html", Admin: "overview.html" };
    if (document.querySelector(".site-nav") && s && HOME[s.role]) {
      document.querySelectorAll('a[href="login.html"]:not(.demo-card)').forEach(function (a) {
        a.setAttribute("href", HOME[s.role]);
        a.childNodes.forEach(function (n) {
          if (n.nodeType === 3 && n.textContent.trim() === "Staff sign in") n.textContent = "Open my workspace";
        });
      });
      const links = document.querySelector(".site-nav .links");
      if (links) links.insertBefore(h("li", { class: "signed-in" }, [h("span", { class: "avatar sm", text: s.name.split(" ").map(function (p) { return p[0]; }).join("").replace(/[^A-Z]/gi, "").slice(0, 2).toUpperCase() }), h("span", { text: s.name })]), links.lastElementChild);
    }
  });

  // ---------- Run an action and show validation errors from the data layer ----------
  function attempt(fn, errBox) {
    try { return fn(); } catch (e) {
      const msg = e.userMessage || "Something went wrong. Please try again.";
      if (errBox) {
        errBox.innerHTML = "";
        errBox.insertAdjacentHTML("afterbegin", Icons.svg("alert", 18));
        errBox.appendChild(h("span", { text: msg }));
        errBox.classList.add("show");
      } else toast(msg, "err");
      if (!e.userMessage) console.error(e);
      return undefined;
    }
  }
  function clearError(errBox) { if (errBox) errBox.classList.remove("show"); }

  const dateLong = function (d) { return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); };
  const dateTime = function (ts) { const d = new Date(ts); return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) + ", " + clock(d); };
  const qty = function (n) { return String(Number(Number(n).toFixed(2))); };
  const compact = function (n) { return n >= 100000 ? (n / 1000).toFixed(0) + "k" : n >= 10000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toLocaleString(); };

  // ---------- Charts (dependency-free SVG) ----------
  const SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text !== undefined) el.textContent = text;
    return el;
  }
  // Vertical bar chart: data = [{ label, value, title }]
  function barChart(container, data, opts) {
    opts = opts || {};
    container.innerHTML = "";
    // Draw at the container's real width so text stays crisp and readable
    const W = Math.max(300, Math.round(container.clientWidth || 640)), H = opts.height || 220, padL = 44, padB = 26, padT = 12;
    if (!container._chartResize && window.ResizeObserver) {
      let last = W;
      container._chartResize = new ResizeObserver(function () {
        const w = Math.round(container.clientWidth);
        if (Math.abs(w - last) > 24 && container._chartArgs) { last = w; barChart.apply(null, container._chartArgs); }
      });
      container._chartResize.observe(container);
    }
    container._chartArgs = [container, data, opts];
    const max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    const step = Math.pow(10, Math.floor(Math.log10(max))), niceMax = Math.ceil(max / step) * step;
    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart-svg", role: "img", "aria-label": opts.label || "Bar chart" });
    for (let i = 0; i <= 4; i++) {
      const y = padT + (H - padT - padB) * (1 - i / 4);
      svg.appendChild(svgEl("line", { x1: padL, x2: W, y1: y, y2: y, class: "grid" }));
      svg.appendChild(svgEl("text", { x: padL - 8, y: y + 4, class: "axis", "text-anchor": "end" }, compact(niceMax * i / 4)));
    }
    const bw = (W - padL) / Math.max(data.length, 1);
    data.forEach(function (d, i) {
      const bh = (H - padT - padB) * (d.value / niceMax);
      const x = padL + i * bw + bw * 0.18, y = H - padB - bh;
      const g = svgEl("g", { class: "bar-g" + (d.highlight ? " hl" : "") });
      g.appendChild(svgEl("rect", { x: x, y: y, width: bw * 0.64, height: Math.max(bh, d.value ? 2 : 0), rx: 4, class: "bar" }));
      g.appendChild(svgEl("rect", { x: padL + i * bw, y: padT, width: bw, height: H - padT - padB, class: "hit" }));
      g.appendChild(svgEl("title", {}, d.title || (d.label + ": " + d.value)));
      svg.appendChild(g);
      if (data.length <= 16 || i % 2 === 0) svg.appendChild(svgEl("text", { x: padL + i * bw + bw / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, d.label));
    });
    container.appendChild(svg);
  }
  // Horizontal bars: rows = [{ label, value, display, sub }]
  function hBars(container, rows) {
    container.innerHTML = "";
    const max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    if (!rows.length) { container.appendChild(h("p", { class: "muted", text: "No sales yet today." })); return; }
    rows.forEach(function (r, i) {
      container.appendChild(h("div", { class: "hbar" }, [
        h("div", { class: "hbar-top" }, [h("span", { class: "hbar-label", text: r.label }), h("span", { class: "hbar-val", text: r.display || String(r.value) })]),
        h("div", { class: "hbar-track" }, [h("div", { class: "hbar-fill" + (i === 0 ? " first" : ""), style: "width:" + Math.max(2, r.value / max * 100) + "%" })]),
        r.sub ? h("div", { class: "hbar-sub", text: r.sub }) : null
      ]));
    });
  }
  // Donut: segments = [{ label, value, color }]
  function donut(container, segments, centerLabel) {
    container.innerHTML = "";
    const total = segments.reduce(function (s, x) { return s + x.value; }, 0);
    const wrap = h("div", { class: "donut-wrap" });
    const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "donut", role: "img", "aria-label": "Share by payment method" });
    const R = 46, C = 2 * Math.PI * R;
    let offset = 0;
    svg.appendChild(svgEl("circle", { cx: 60, cy: 60, r: R, class: "donut-bg" }));
    segments.forEach(function (s) {
      if (!s.value) return;
      const len = C * s.value / (total || 1);
      const c = svgEl("circle", { cx: 60, cy: 60, r: R, stroke: s.color, "stroke-dasharray": len + " " + (C - len), "stroke-dashoffset": -offset, class: "donut-seg" });
      c.appendChild(svgEl("title", {}, s.label + ": " + Math.round(s.value / total * 100) + "%"));
      svg.appendChild(c);
      offset += len;
    });
    svg.appendChild(svgEl("text", { x: 60, y: 57, class: "donut-num", "text-anchor": "middle" }, centerLabel || compact(total)));
    svg.appendChild(svgEl("text", { x: 60, y: 73, class: "donut-cap", "text-anchor": "middle" }, "total"));
    wrap.appendChild(svg);
    wrap.appendChild(h("ul", { class: "donut-legend" }, segments.map(function (s) {
      return h("li", null, [h("i", { style: "background:" + s.color }), h("span", { text: s.label }), h("b", { text: total ? Math.round(s.value / total * 100) + "%" : "0%" }), h("small", { text: money(s.value) })]);
    })));
    container.appendChild(wrap);
  }

  // ---------- CSV export (neutralises spreadsheet formula injection) ----------
  function downloadCSV(filename, rows) {
    const esc = function (v) {
      let s = String(v === null || v === undefined ? "" : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = rows.map(function (r) { return r.map(esc).join(","); }).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  window.CMS = {
    h: h, money: money, timeAgo: timeAgo, clock: clock, dateLong: dateLong, dateTime: dateTime, compact: compact, qty: qty,
    toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog,
    attempt: attempt, clearError: clearError, barChart: barChart, hBars: hBars, donut: donut, downloadCSV: downloadCSV
  };
  window.Session = Session;
})();
