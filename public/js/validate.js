// Client-side checks for forms and file pickers.
// They trim input, enforce required fields, length limits and formats, and show a message under each
// field, so people get quick, clear feedback. They are only a first screen: anyone can turn them off in
// their own browser, so the server repeats every one of these checks and is the real enforcement.
(function () {
  const h = CMS.h;

  // ---------- Formats ----------
  // Each format has a test and the message shown when the value does not match it.
  const FORMATS = {
    // Letters from any language, with spaces, full stops, apostrophes and hyphens between them
    personName: {
      test: function (v) { return /^\p{L}[\p{L}\p{M} .'-]*$/u.test(v); },
      message: function (label) { return label + " can use only letters, spaces, full stops, apostrophes and hyphens."; }
    },
    // A Pakistani mobile number: 03 followed by 9 digits. Spaces and dashes are removed first.
    mobile: {
      normalize: function (v) { return v.replace(/[\s-]/g, ""); },
      test: function (v) { return /^03\d{9}$/.test(v); },
      message: function () { return "Enter the mobile number as 03XXXXXXXXX (11 digits, starting with 03)."; }
    },
    // Same rule as the server: starts with a letter, then letters, numbers, dots or underscores
    username: {
      normalize: function (v) { return v.toLowerCase(); },
      test: function (v) { return /^[a-z][a-z0-9._]{2,29}$/.test(v); },
      message: function () { return "Username must be 3-30 letters, numbers, dots or underscores, starting with a letter."; }
    },
    date: {
      test: function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v); },
      message: function (label) { return "Choose a valid " + label.toLowerCase() + "."; }
    },
    time: {
      test: function (v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); },
      message: function (label) { return "Choose a valid " + label.toLowerCase() + "."; }
    },
    // Text that will be shown to other people: angle brackets are not needed in a note or a reason
    plainText: {
      test: function (v) { return !/[<>]/.test(v); },
      message: function (label) { return label + " cannot contain < or >."; }
    }
  };

  function realDate(v) {
    const parts = v.split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return d.getUTCFullYear() === parts[0] && d.getUTCMonth() === parts[1] - 1 && d.getUTCDate() === parts[2];
  }

  function localDate(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + (offsetDays || 0));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Control characters (tabs, new lines in a one-line field, invisible marks) are replaced by spaces
  const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

  // ---------- Messages under fields ----------
  function errorNode(input) {
    const id = input.id + "-error";
    let node = document.getElementById(id);
    if (!node) {
      node = h("div", { class: "field-error", id: id });
      const field = input.closest(".field") || input.parentNode;
      field.appendChild(node);
    }
    return node;
  }

  function describe(input, id, add) {
    const list = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean).filter(function (x) { return x !== id; });
    if (add) list.push(id);
    if (list.length) input.setAttribute("aria-describedby", list.join(" ")); else input.removeAttribute("aria-describedby");
  }

  function showFieldError(input, message) {
    const node = errorNode(input);
    node.textContent = message;
    node.classList.add("show");
    input.classList.add("is-invalid");
    input.setAttribute("aria-invalid", "true");
    describe(input, node.id, true);
  }

  function clearFieldError(input) {
    const node = document.getElementById(input.id + "-error");
    if (node) { node.textContent = ""; node.classList.remove("show"); describe(input, node.id, false); }
    input.classList.remove("is-invalid");
    input.removeAttribute("aria-invalid");
  }

  function showSummary(box, messages) {
    if (!box) return;
    box.replaceChildren();
    box.prepend(Icons.node("alert", 18));
    const text = messages.length === 1 ? messages[0] : "Please correct the " + messages.length + " highlighted fields. " + messages[0];
    box.appendChild(h("span", { text: text }));
    box.classList.add("show");
  }

  // ---------- One field ----------
  // Returns [cleanValue, message]. The message is empty when the value is acceptable.
  function checkField(rule, input, values) {
    const label = rule.label;
    let value = input.value;
    const isPassword = input.type === "password";
    if (typeof value !== "string") value = "";
    // Passwords are kept exactly as typed: a space can be part of a password
    if (!isPassword && rule.trim !== false) {
      value = value.replace(CONTROL, " ").trim();
      if (rule.collapseSpaces) value = value.replace(/\s{2,}/g, " ");
    }
    const format = rule.format ? FORMATS[rule.format] : null;
    if (format && format.normalize) value = format.normalize(value);

    // A number box holding text such as "abc" reports an empty value; say what is really wrong
    if (value === "" && input.validity && input.validity.badInput) return [value, label + " must be a number."];
    if (value === "") return [value, rule.required ? (rule.requiredMessage || label + " is required.") : ""];

    if (rule.min && value.length < rule.min) return [value, label + " must be at least " + rule.min + " characters."];
    if (rule.max && value.length > rule.max) return [value, label + " must be " + rule.max + " characters or fewer."];

    if (format && !format.test(value)) return [value, format.message(label)];

    if (rule.number) {
      const n = Number(value);
      const range = rule.number;
      const wrong = label + " must be " + (range.integer === false ? "a number" : "a whole number") + " from " + range.min.toLocaleString() + " to " + range.max.toLocaleString() + ".";
      if (!/^-?[0-9.]+$/.test(value) || value.split(".").length > 2 || !Number.isFinite(n)) return [value, wrong];
      if (range.integer !== false && !Number.isInteger(n)) return [value, wrong];
      if (n < range.min || n > range.max) return [value, wrong];
    }

    if (rule.notBefore) {
      const earliest = typeof rule.notBefore === "function" ? rule.notBefore() : rule.notBefore;
      if (value < earliest) return [value, label + " cannot be in the past."];
    }
    if (rule.notAfter) {
      const latest = typeof rule.notAfter === "function" ? rule.notAfter() : rule.notAfter;
      if (value > latest) return [value, rule.notAfterMessage || label + " is too far ahead."];
    }
    if (rule.timeFrom && (value < rule.timeFrom || value > rule.timeTo)) {
      return [value, "Choose a time between " + rule.timeFrom + " and " + rule.timeTo + "."];
    }
    if (rule.custom) {
      const message = rule.custom(value, values);
      if (message) return [value, message];
    }
    return [value, ""];
  }

  // ---------- A whole form ----------
  // rules: { fieldId: { label, required, min, max, format, number, notBefore, notAfter, timeFrom, timeTo, custom } }
  // opts.summary: the form's alert box. Returns { check, reset }.
  function attach(form, rules, opts) {
    opts = opts || {};
    const ids = Object.keys(rules);
    const input = function (id) { return document.getElementById(id); };

    ids.forEach(function (id) {
      const el = input(id);
      const rule = rules[id];
      // The browser's own length limits match the rules, so over-long text cannot even be typed
      if (rule.max && el.type !== "number" && el.type !== "date" && el.type !== "time") el.setAttribute("maxlength", String(rule.max));
      if (rule.min && el.type !== "number") el.setAttribute("minlength", String(rule.min));
      if (rule.required) el.setAttribute("aria-required", "true");
      // Check a field when the person leaves it, and clear the message as soon as it is fixed
      el.addEventListener("blur", function () {
        if (el.value === "" && !el.classList.contains("is-invalid")) return;
        validateOne(id);
      });
      el.addEventListener("input", function () { if (el.classList.contains("is-invalid")) validateOne(id); });
      el.addEventListener("change", function () { if (el.classList.contains("is-invalid")) validateOne(id); });
    });

    function currentValues() {
      const values = {};
      ids.forEach(function (id) { values[id] = input(id).value; });
      return values;
    }

    function validateOne(id) {
      const result = checkField(rules[id], input(id), currentValues());
      if (result[1]) showFieldError(input(id), result[1]); else clearFieldError(input(id));
      return result;
    }

    // Checks every field, writes the trimmed values back, and shows all the problems at once
    function check() {
      const values = {};
      const messages = [];
      let first = null;
      ids.forEach(function (id) { values[id] = input(id).value; });
      ids.forEach(function (id) {
        const el = input(id);
        const result = checkField(rules[id], el, values);
        values[id] = result[0];
        if (el.type !== "password" && el.type !== "file" && el.value !== result[0]) el.value = result[0];
        if (result[1]) {
          showFieldError(el, result[1]);
          messages.push(result[1]);
          if (!first) first = el;
        } else clearFieldError(el);
      });
      if (messages.length) {
        showSummary(opts.summary, messages);
        first.focus();
        return { ok: false, values: values, messages: messages };
      }
      if (opts.summary) opts.summary.classList.remove("show");
      return { ok: true, values: values, messages: [] };
    }

    function reset() {
      ids.forEach(function (id) { clearFieldError(input(id)); });
      if (opts.summary) opts.summary.classList.remove("show");
    }
    form.addEventListener("reset", function () { setTimeout(reset, 0); });

    return { check: check, reset: reset };
  }

  // ---------- File pickers ----------
  // Checks the extension, the browser-reported type, the size and the first bytes of the file.
  // This is only a first screen: a file can still lie about what it is, so the server decodes and
  // rebuilds every image and refuses anything that is not a real picture.
  const SIGNATURES = {
    png: function (b) { return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a; },
    jpeg: function (b) { return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; },
    webp: function (b) { return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; }
  };

  function sizeText(bytes) {
    if (bytes < 1024) return bytes + " bytes";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function readStart(file, count) {
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { resolve(new Uint8Array(0)); };
      reader.readAsArrayBuffer(file.slice(0, count));
    });
  }

  // opts: { types: { ".png": "png", ".jpg": "jpeg", ... }, mimes: [...], maxBytes, label: "PNG, JPEG or WebP" }
  // Returns a promise of "" when the file is acceptable, or the message to show.
  async function checkFile(file, opts) {
    if (!file) return "";
    const name = String(file.name || "");
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
    const allowed = Object.keys(opts.types);
    const list = opts.label || allowed.map(function (x) { return x.slice(1).toUpperCase(); }).join(", ");
    if (name.length > 120) return "The file name is too long. Rename the file to 120 characters or fewer.";
    // The last extension must be on the list, and a hidden second one such as photo.php.png is refused
    const hidden = /\.(php\d?|phtml|asp|aspx|jsp|exe|com|bat|cmd|ps1|sh|js|mjs|html?|svg|xml|hta)\./i;
    if (!ext || !Object.hasOwn(opts.types, ext) || hidden.test(name.slice(0, dot + 1))) {
      return "\"" + name + "\" is not an allowed file type. Choose a " + list + " file.";
    }
    if (opts.mimes.indexOf(file.type) === -1) return "\"" + name + "\" does not look like a " + list + " image. Choose a real picture file.";
    if (file.size === 0) return "\"" + name + "\" is empty. Choose another file.";
    if (file.size > opts.maxBytes) return "\"" + name + "\" is " + sizeText(file.size) + ". The largest file allowed is " + sizeText(opts.maxBytes) + ".";
    const start = await readStart(file, 16);
    if (!SIGNATURES[opts.types[ext]](start)) return "\"" + name + "\" is named ." + ext.slice(1) + " but its contents are not a " + ext.slice(1).toUpperCase() + " image.";
    return "";
  }

  // Wires a file input: checks on every selection, clears a refused file, and shows the result.
  // Returns { check } so the form can check again just before uploading.
  function attachFile(inputEl, opts) {
    const status = h("div", { class: "file-status", id: inputEl.id + "-status", "aria-live": "polite" });
    (inputEl.closest(".field") || inputEl.parentNode).appendChild(status);
    describe(inputEl, status.id, true);
    // The picker offers only the allowed types, though a person can still pick "All files"
    inputEl.setAttribute("accept", Object.keys(opts.types).concat(opts.mimes).join(","));

    async function check() {
      const file = inputEl.files && inputEl.files[0];
      status.textContent = "";
      status.classList.remove("ok");
      if (!file) { clearFieldError(inputEl); return true; }
      const message = await checkFile(file, opts);
      if (message) {
        inputEl.value = "";
        showFieldError(inputEl, message);
        return false;
      }
      clearFieldError(inputEl);
      status.textContent = "Ready to upload: " + file.name + " (" + sizeText(file.size) + ")";
      status.classList.add("ok");
      return true;
    }
    inputEl.addEventListener("change", check);
    return {
      check: check,
      reset: function () { inputEl.value = ""; status.textContent = ""; status.classList.remove("ok"); clearFieldError(inputEl); }
    };
  }

  // ---------- Password strength feedback ----------
  // Calls the instructor's checkPasswordStrength(password) from password_strength_helper.js, unchanged,
  // every time the password is typed, pasted or cleared, and shows the level and message under the field.
  // It is feedback only: the server still enforces the password rules and refuses common passwords.
  function attachStrength(inputEl) {
    const level = h("b", { class: "pw-strength-level" });
    const score = h("span", { class: "pw-strength-score" });
    const bar = h("div", { class: "pw-strength-bar", "aria-hidden": "true" }, [1, 2, 3, 4, 5, 6].map(function () { return h("i"); }));
    const message = h("p", { class: "pw-strength-msg" });
    const box = h("div", { class: "pw-strength", id: inputEl.id + "-strength", "aria-live": "polite", "data-level": "" }, [
      h("div", { class: "pw-strength-top" }, [h("span", { text: "Password strength: " }), level, score]),
      bar,
      message
    ]);
    box.hidden = true;
    const field = inputEl.closest(".field") || inputEl.parentNode;
    const rules = field.querySelector(".pw-rules");
    field.insertBefore(box, rules || null);
    describe(inputEl, box.id, true);

    function update() {
      if (typeof window.checkPasswordStrength !== "function") { box.hidden = true; return null; }
      if (inputEl.value === "") { box.hidden = true; box.setAttribute("data-level", ""); return null; }
      const result = window.checkPasswordStrength(inputEl.value);
      box.hidden = false;
      level.textContent = result.level;
      score.textContent = " (" + result.score + " of " + result.maximumScore + ")";
      message.textContent = result.message;
      box.setAttribute("data-level", result.level.toLowerCase());
      Array.prototype.forEach.call(bar.children, function (seg, i) { seg.classList.toggle("on", i < result.score); });
      return result;
    }
    ["input", "change", "paste", "cut"].forEach(function (ev) { inputEl.addEventListener(ev, function () { setTimeout(update, 0); }); });
    const form = inputEl.form;
    if (form) form.addEventListener("reset", function () { setTimeout(update, 0); });
    return { update: update };
  }

  window.Validate = { attach: attach, attachFile: attachFile, attachStrength: attachStrength, checkFile: checkFile, formats: FORMATS, today: localDate, sizeText: sizeText };
})();
