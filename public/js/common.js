// Shared helpers used on every page.
(function () {
  // The old prototype kept a full copy of the database in the browser. Remove it from any device that still has one.
  try { ["cms_db_v4", "cms_kds_heartbeat"].forEach(function (key) { localStorage.removeItem(key); }); } catch (e) { /* storage unavailable */ }

  // ---------- DOM helper: builds elements with textContent only, so data can never become markup ----------
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text" || k === "icon" || k === "iconSize") return;
        else if (k === "css") Object.assign(el.style, v);
        else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
      if (attrs.text !== undefined) el.textContent = attrs.text;
      if (attrs.icon) el.prepend(Icons.node(attrs.icon, attrs.iconSize || 16));
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

  // ---------- API client ----------
  // The real session is a signed HttpOnly cookie that scripts cannot read. Every failure carries a
  // safe message from the server in userMessage, which CMS.attempt and the forms display.
  // ---------- Personal signing key ----------
  // Each browser makes its own ECDSA P-256 key. The private half is created as non-exportable and kept
  // in this browser's IndexedDB; only the public half goes to the server. Sensitive actions are signed
  // with it, so they can be proved to come from this person's device.
  const Signer = {
    encode: function (text) { return new TextEncoder().encode(text); },
    open: function () {
      return new Promise(function (resolve, reject) {
        const request = indexedDB.open("cms-signing", 1);
        request.onupgradeneeded = function () { request.result.createObjectStore("keys"); };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    },
    get: async function (user) {
      const db = await Signer.open();
      return new Promise(function (resolve) {
        const request = db.transaction("keys").objectStore("keys").get(user);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
      });
    },
    put: async function (user, value) {
      const db = await Signer.open();
      return new Promise(function (resolve, reject) {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(value, user);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    },
    register: async function (user) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const label = (navigator.platform || "This device") + " browser";
      const result = await Api.call("POST", "/auth/signing-keys", { publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, label: label.slice(0, 60) }, { unsigned: true });
      await Signer.put(user, { keyId: result.id, privateKey: pair.privateKey });
    },
    ensure: async function (user) { if (!(await Signer.get(user))) await Signer.register(user); },
    headers: async function (method, url, bodyText) {
      const session = Session.get();
      if (!session || !window.crypto || !crypto.subtle || !window.indexedDB) return {};
      const key = await Signer.get(session.user).catch(function () { return null; });
      if (!key) return {};
      const signedAt = String(Date.now());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Signer.encode(bodyText || "")));
      const bodyHash = Array.from(digest).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
      const text = ["cafems-action-v1", method, url, signedAt, bodyHash].join("\n");
      const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, Signer.encode(text)));
      let binary = "";
      signature.forEach(function (b) { binary += String.fromCharCode(b); });
      return { "X-Signing-Key": key.keyId, "X-Signed-At": signedAt, "X-Action-Signature": btoa(binary) };
    }
  };

  const Api = {
    csrfToken: null,
    call: async function (method, path, body, opts) {
      opts = opts || {};
      const headers = Object.assign({ Accept: "application/json" }, opts.headers);
      const bodyText = body === undefined ? undefined : JSON.stringify(body);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (method !== "GET" && !opts.public) {
        if (!Api.csrfToken) await Api.me();
        headers["X-CSRF-Token"] = Api.csrfToken;
        if (!opts.unsigned) Object.assign(headers, await Signer.headers(method, "/api/v1" + path, bodyText).catch(function () { return {}; }));
      }
      let response;
      try {
        response = await fetch("/api/v1" + path, { method: method, headers: headers, credentials: "same-origin", body: bodyText });
      } catch (e) {
        const offline = new Error("Could not reach the server. Check your connection and try again.");
        offline.userMessage = offline.message;
        throw offline;
      }
      if (response.status === 204) return null;
      const data = await response.json().catch(function () { return null; });
      if (!response.ok) {
        const info = data && data.error ? data.error : {};
        // No key on this device yet, or the old one was removed: make a new one and try once more
        if ((info.code === "signature_required" || info.code === "signature_invalid") && !opts.retried && Session.get()) {
          await Signer.register(Session.get().user);
          return Api.call(method, path, body, Object.assign({}, opts, { retried: true }));
        }
        const failure = new Error(info.message || "Something went wrong. Please try again.");
        failure.userMessage = failure.message;
        failure.status = response.status;
        failure.code = info.code;
        throw failure;
      }
      return data;
    },
    upload: async function (path, file) {
      if (!Api.csrfToken) await Api.me();
      const response = await fetch("/api/v1" + path, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": file.type, "X-CSRF-Token": Api.csrfToken }, body: file });
      if (response.ok) return;
      const info = await response.json().catch(function () { return {}; });
      const failure = new Error((info.error && info.error.message) || "The file could not be uploaded.");
      failure.userMessage = failure.message;
      throw failure;
    },
    // Downloads a server-generated file, so the server can check, limit and log the export
    download: async function (path, filename) {
      const response = await fetch("/api/v1" + path, { credentials: "same-origin" });
      if (!response.ok) {
        const info = await response.json().catch(function () { return {}; });
        const failure = new Error((info.error && info.error.message) || "The export could not be created.");
        failure.userMessage = failure.message;
        throw failure;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = h("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },
    me: async function () {
      const me = await Api.call("GET", "/auth/me");
      Api.csrfToken = me.csrfToken;
      return me;
    }
  };

  // ---------- Display copy of the signed-in user ----------
  // Used only to draw names and menus. It is not trusted: the server checks the cookie on every request.
  const Session = {
    KEY: "cms_session",
    get: function () { try { return JSON.parse(sessionStorage.getItem(this.KEY)); } catch (e) { return null; } },
    set: function (d) { try { sessionStorage.setItem(this.KEY, JSON.stringify(d)); } catch (e) { /* storage unavailable: names are simply not shown */ } },
    clear: function () { try { sessionStorage.removeItem(this.KEY); } catch (e) { /* storage unavailable: nothing to clear */ } },
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
      document.querySelectorAll('a[href="login.html"]').forEach(function (a) {
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
  async function attempt(fn, errBox) {
    try { return await fn(); } catch (e) {
      const msg = e.userMessage || "Something went wrong. Please try again.";
      if (errBox) {
        errBox.replaceChildren();
        errBox.prepend(Icons.node("alert", 18));
        errBox.appendChild(h("span", { text: msg }));
        errBox.classList.add("show");
      } else toast(msg, "err");
      if (!e.userMessage) console.error(e);
      return undefined;
    }
  }
  function clearError(errBox) { if (errBox) errBox.classList.remove("show"); }

  // Stops double submission: the button stays disabled until the server has answered
  async function busy(button, work) {
    if (button.disabled) return undefined;
    button.disabled = true;
    try { return await work(); } finally { button.disabled = false; }
  }

  // ---------- Fresh authenticator code for sensitive actions ----------
  function askForCode() {
    return new Promise(function (resolve) {
      const id = "stepup-" + Date.now();
      const input = h("input", { class: "input", type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", "aria-label": "Authenticator code", "data-autofocus": true });
      const okBtn = h("button", { class: "btn btn-primary", type: "submit", text: "Confirm" });
      const cancelBtn = h("button", { class: "btn btn-secondary", type: "button", text: "Cancel" });
      const form = h("form", { class: "modal" }, [
        h("div", { class: "modal-head" }, [
          h("div", { class: "icon-tile warn", icon: "shield", iconSize: 20 }),
          h("div", null, [h("h3", { id: id + "-t", text: "Confirm it's you" }), h("p", { text: "Enter a new code from your authenticator app. A code can be used only once, so you may need to wait for the next one." })])
        ]),
        h("div", { class: "modal-body" }, [input]),
        h("div", { class: "modal-actions" }, [cancelBtn, okBtn])
      ]);
      const backdrop = h("div", { class: "modal-backdrop", id: id, role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t", "data-static": true }, [form]);
      document.body.appendChild(backdrop);
      const done = function (value) { closeModal(id); backdrop.remove(); resolve(value); };
      cancelBtn.addEventListener("click", function () { done(null); });
      form.addEventListener("submit", function (e) { e.preventDefault(); done(input.value.trim()); });
      openModal(id);
      input.focus();
    });
  }

  // Runs an action. If the server asks for a fresh code, asks the user, proves it, and tries once more.
  async function withStepUp(action) {
    try {
      return await action();
    } catch (error) {
      if (error.code !== "step_up_required") throw error;
    }
    const code = await askForCode();
    if (!code) {
      const cancelled = new Error("Cancelled.");
      cancelled.userMessage = "Cancelled. Nothing was changed.";
      throw cancelled;
    }
    await Api.call("POST", "/auth/step-up", { code: code });
    return action();
  }

  // Shows a one-time link to the Admin, who passes it on in person
  function showLink(title, result) {
    const input = h("input", { class: "input mono", type: "text", readonly: true, "aria-label": "One-time link" });
    input.value = result.setupUrl;
    const id = "link-" + Date.now();
    const copyBtn = h("button", { class: "btn btn-secondary", type: "button", text: "Copy link" });
    const closeBtn = h("button", { class: "btn btn-primary", type: "button", text: "Done", "data-autofocus": true });
    const backdrop = h("div", { class: "modal-backdrop", id: id, role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-t", "data-static": true }, [
      h("div", { class: "modal" }, [
        h("div", { class: "modal-head" }, [
          h("div", { class: "icon-tile", icon: "key", iconSize: 20 }),
          h("div", null, [h("h3", { id: id + "-t", text: title }), h("p", { text: "Give this link to the person directly. It works once, expires in 24 hours and is not shown again." })])
        ]),
        h("div", { class: "modal-body" }, [input]),
        h("div", { class: "modal-actions" }, [copyBtn, closeBtn])
      ])
    ]);
    document.body.appendChild(backdrop);
    copyBtn.addEventListener("click", function () { copyText(input.value, "Link copied"); });
    closeBtn.addEventListener("click", function () { closeModal(id); backdrop.remove(); });
    openModal(id);
  }

  function copyText(text, doneMessage) {
    // Some browsers block the modern clipboard, so an older method is tried before giving up
    const fallback = function () {
      const area = h("textarea", { class: "sr-only", readonly: true, "aria-hidden": "true" });
      const previous = document.activeElement;
      area.value = text;
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (e) { copied = false; }
      area.remove();
      if (previous && previous.focus) previous.focus();
      if (copied) toast(doneMessage, "ok");
      else toast("Your browser blocked copying. Select the text and copy it by hand.", "err");
    };
    if (!navigator.clipboard) { fallback(); return; }
    navigator.clipboard.writeText(text).then(function () { toast(doneMessage, "ok"); }, fallback);
  }

  // Copy and Download buttons for recovery codes. The file is made here in the browser; nothing is sent anywhere.
  function codeActions(codes) {
    const save = function () {
      const content = ["CafeMS recovery codes", "Saved " + new Date().toLocaleString(), "Each code works once. Keep this file private.", ""].concat(codes).join("\r\n") + "\r\n";
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const a = h("a", { href: url, download: "cafems-recovery-codes.txt" });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast("Recovery codes downloaded", "ok");
    };
    return h("div", { class: "code-actions" }, [
      h("button", { class: "btn btn-secondary btn-sm", type: "button", icon: "clipboard", iconSize: 15, text: "Copy codes", onclick: function () { copyText(codes.join("\n"), "Recovery codes copied"); } }),
      h("button", { class: "btn btn-secondary btn-sm", type: "button", icon: "file", iconSize: 15, text: "Download codes", onclick: save })
    ]);
  }

  // Shared list of requests waiting for a second person (Manager and Admin screens)
  function renderApprovals(list) {
    list.replaceChildren();
    const rows = Store.approvals();
    if (!rows.length) { list.appendChild(h("li", { class: "empty-li" }, [h("span", { class: "muted", text: "Nothing is waiting for approval." })])); return; }
    const decide = async function (a, decision, button) {
      await busy(button, async function () {
        const result = await attempt(function () { return withStepUp(function () { return Store.decideApproval(a.id, decision); }); });
        if (result === undefined) return;
        if (result && result.setupUrl) showLink("Approved: one-time link", result);
        toast(decision === "approve" ? "Request approved" : "Request rejected", "ok");
      });
    };
    rows.forEach(function (a) {
      const approve = h("button", { class: "btn btn-primary btn-sm", type: "button", text: "Approve", onclick: function (e) { decide(a, "approve", e.currentTarget); } });
      const reject = h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Reject", onclick: function (e) { decide(a, "reject", e.currentTarget); } });
      list.appendChild(h("li", null, [
        h("span", { class: "tno warn", icon: "shield", iconSize: 18 }),
        h("div", { class: "meta" }, [h("b", { text: a.summary }), h("small", { text: "Requested by " + a.requestedBy + " · " + timeAgo(a.createdAt) })]),
        h("div", { class: "row-actions" }, [approve, reject])
      ]));
    });
  }

  // Full customer numbers are fetched only on request, and the server logs each one
  async function showPhone(load) {
    const phone = await attempt(load);
    if (!phone) return;
    confirmDialog({ title: "Customer number", message: phone + ". This view has been recorded in the audit log.", okText: "Close", cancelText: "Hide", icon: "user" });
  }

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
    container.replaceChildren();
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
    const max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([100]));
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
    container.replaceChildren();
    const max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    if (!rows.length) { container.appendChild(h("p", { class: "muted", text: "No sales yet today." })); return; }
    rows.forEach(function (r, i) {
      container.appendChild(h("div", { class: "hbar" }, [
        h("div", { class: "hbar-top" }, [h("span", { class: "hbar-label", text: r.label }), h("span", { class: "hbar-val", text: r.display || String(r.value) })]),
        h("div", { class: "hbar-track" }, [h("div", { class: "hbar-fill" + (i === 0 ? " first" : ""), css: { width: Math.max(2, r.value / max * 100) + "%" } })]),
        r.sub ? h("div", { class: "hbar-sub", text: r.sub }) : null
      ]));
    });
  }
  // Donut: segments = [{ label, value, color }]
  function donut(container, segments, centerLabel) {
    container.replaceChildren();
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
      return h("li", null, [h("i", { css: { background: s.color } }), h("span", { text: s.label }), h("b", { text: total ? Math.round(s.value / total * 100) + "%" : "0%" }), h("small", { text: money(s.value) })]);
    })));
    container.appendChild(wrap);
  }

  window.CMS = {
    h: h, money: money, timeAgo: timeAgo, clock: clock, dateLong: dateLong, dateTime: dateTime, compact: compact, qty: qty,
    toast: toast, openModal: openModal, closeModal: closeModal, confirm: confirmDialog,
    attempt: attempt, clearError: clearError, busy: busy, withStepUp: withStepUp, showLink: showLink, copyText: copyText, codeActions: codeActions, renderApprovals: renderApprovals, showPhone: showPhone,
    barChart: barChart, hBars: hBars, donut: donut
  };
  window.Session = Session;
  window.Api = Api;
  window.Signer = Signer;
})();
