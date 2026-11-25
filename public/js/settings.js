// Settings (Admin): cafe profile, tax, discount limits, receipt text and tables. The page only edits
// a copy; the server checks every value, asks for a fresh authenticator code and refuses a save made
// from an out-of-date copy, so two Admins cannot overwrite each other's changes.
(function () {
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  const saveBtn = el("saveOps");
  const opsErr = el("opsErr");
  let draft = null;
  let dirty = false;

  function markDirty() {
    dirty = true;
    saveBtn.disabled = false;
    preview();
  }
  window.addEventListener("beforeunload", function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ---------- Cafe profile (saved on its own) ----------
  const PROFILE = ["name", "tagline", "about", "address", "phone", "hours"];
  function fillProfile() {
    const cafe = Store.cafe();
    PROFILE.forEach(function (k) { el("cafe-" + k).value = cafe[k] || ""; });
    preview();
  }
  el("profileForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = el("profileErr");
    CMS.clearError(err);
    const details = {};
    PROFILE.forEach(function (k) { details[k] = el("cafe-" + k).value; });
    const ok = await CMS.busy(el("saveProfile"), function () { return CMS.attempt(function () { return Store.saveCafe(details); }, err); });
    if (ok) CMS.toast("Cafe profile saved", "ok");
  });
  el("cafe-name").addEventListener("input", preview);

  // ---------- Operating settings ----------
  function number(id) { return Number(el(id).value); }
  function readForm() {
    return {
      version: draft.version,
      taxRatePct: number("taxRate"),
      discountLimits: { Cashier: number("limitCashier"), Manager: number("limitManager") },
      receipt: { header: el("receiptHeader").value, footer: el("receiptFooter").value },
      tables: draft.tables.map(function (t) { return { no: Number(t.no), seats: Number(t.seats), area: String(t.area || "").trim() }; }),
      categories: draft.categories.map(function (c) { return { name: String(c.name || "").trim(), station: c.station }; }),
      orderTypes: { dineIn: el("typeDineIn").checked, takeaway: el("typeTakeaway").checked, delivery: el("typeDelivery").checked }
    };
  }

  function preview() {
    el("previewName").textContent = el("cafe-name").value || "CafeMS";
    el("previewHeader").textContent = el("receiptHeader").value;
    el("previewFooter").textContent = el("receiptFooter").value;
    const rate = Math.max(0, Number(el("taxRate").value) || 0);
    const tax = Math.round(450 * rate / 100);
    el("previewTax").textContent = CMS.money(tax);
    el("previewTotal").textContent = CMS.money(450 + tax);
  }

  function renderTables() {
    const body = el("tableRows");
    body.replaceChildren();
    el("tableCount").textContent = String(draft.tables.length);
    draft.tables.forEach(function (t, i) {
      const input = function (key, attrs) {
        const box = h("input", Object.assign({ class: "input input-sm", "aria-label": key + " for row " + (i + 1) }, attrs));
        box.value = t[key];
        box.addEventListener("input", function () { t[key] = box.value; markDirty(); });
        return box;
      };
      body.appendChild(h("tr", null, [
        h("td", null, [input("no", { type: "number", min: "1", max: "999", inputmode: "numeric" })]),
        h("td", null, [input("seats", { type: "number", min: "1", max: "20", inputmode: "numeric" })]),
        h("td", null, [input("area", { type: "text", maxlength: "30", list: "areaList" })]),
        h("td", { class: "actions" }, [h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Remove table " + t.no, onclick: function () {
          draft.tables.splice(i, 1);
          renderTables();
          markDirty();
        } }, [App.I("trash", 16)])])
      ]));
    });
    // Area names already in use are offered while typing
    let list = el("areaList");
    if (!list) { list = h("datalist", { id: "areaList" }); document.body.appendChild(list); }
    list.replaceChildren();
    Array.from(new Set(draft.tables.map(function (t) { return t.area; }).filter(Boolean))).forEach(function (a) { list.appendChild(h("option", { value: a })); });
  }

  function renderCategories() {
    const body = el("categoryRows");
    body.replaceChildren();
    draft.categories.forEach(function (c, i) {
      const name = h("input", { class: "input input-sm", maxlength: "24", "aria-label": "Category name, row " + (i + 1) });
      name.value = c.name;
      name.addEventListener("input", function () { c.name = name.value; markDirty(); });
      const station = h("select", { class: "select input-sm station-select", "aria-label": "Station for " + c.name }, [h("option", { value: "Kitchen", text: "Kitchen" }), h("option", { value: "Bar", text: "Bar" })]);
      station.value = c.station;
      station.addEventListener("change", function () { c.station = station.value; markDirty(); });
      const move = function (d) { return function () { const j = i + d; if (j < 0 || j >= draft.categories.length) return; const t = draft.categories[i]; draft.categories[i] = draft.categories[j]; draft.categories[j] = t; renderCategories(); markDirty(); }; };
      body.appendChild(h("tr", null, [
        h("td", null, [name]), h("td", null, [station]),
        h("td", { class: "actions" }, [h("div", { class: "row-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Move " + c.name + " up", disabled: i === 0, onclick: move(-1), text: "↑" }),
          h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Move " + c.name + " down", disabled: i === draft.categories.length - 1, onclick: move(1), text: "↓" }),
          h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Remove " + c.name, onclick: function () { draft.categories.splice(i, 1); renderCategories(); markDirty(); } }, [App.I("trash", 16)])
        ])])
      ]));
    });
  }
  el("addCategory").addEventListener("click", function () {
    draft.categories.push({ name: "", station: "Kitchen" });
    renderCategories();
    markDirty();
    const rows = el("categoryRows").querySelectorAll("tr");
    rows[rows.length - 1].querySelector("input").focus();
  });
  ["typeDineIn", "typeTakeaway", "typeDelivery"].forEach(function (id) { el(id).addEventListener("change", markDirty); });

  el("addTable").addEventListener("click", function () {
    const next = draft.tables.reduce(function (m, t) { return Math.max(m, Number(t.no) || 0); }, 0) + 1;
    const lastArea = draft.tables.length ? draft.tables[draft.tables.length - 1].area : "Main hall";
    draft.tables.push({ no: next, seats: 4, area: lastArea });
    renderTables();
    markDirty();
    const rows = el("tableRows").querySelectorAll("tr");
    rows[rows.length - 1].querySelector("input").focus();
  });

  function fill(settings) {
    draft = JSON.parse(JSON.stringify(settings));
    el("taxRate").value = draft.taxRatePct;
    el("limitCashier").value = draft.discountLimits.Cashier;
    el("limitManager").value = draft.discountLimits.Manager;
    el("receiptHeader").value = draft.receipt.header;
    el("receiptFooter").value = draft.receipt.footer;
    renderTables();
    renderCategories();
    el("typeDineIn").checked = draft.orderTypes.dineIn;
    el("typeTakeaway").checked = draft.orderTypes.takeaway;
    el("typeDelivery").checked = draft.orderTypes.delivery;
    dirty = false;
    saveBtn.disabled = true;
    preview();
  }
  ["taxRate", "limitCashier", "limitManager", "receiptHeader", "receiptFooter"].forEach(function (id) { el(id).addEventListener("input", markDirty); });

  saveBtn.addEventListener("click", function () {
    CMS.clearError(opsErr);
    const body = readForm();
    CMS.busy(saveBtn, async function () {
      const saved = await CMS.attempt(function () { return CMS.withStepUp(function () { return Store.saveSettings(body); }); }, opsErr);
      if (!saved) { opsErr.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      fill(saved);
      CMS.toast("Settings saved", "ok");
    }).then(function () { saveBtn.disabled = !dirty; });
  });

  App.ready(async function () {
    fillProfile();
    const settings = await CMS.attempt(function () { return Store.settings(); }, opsErr);
    if (settings) fill(settings);
    // Another Admin's save arrives as a live update; an unsaved copy here is never overwritten
    Store.on(async function () {
      if (dirty) return;
      const latest = await Store.settings().catch(function () { return null; });
      if (latest && latest.version !== draft.version) { fill(latest); CMS.toast("Settings were updated by another Admin", "info"); }
    });
  });
})();
