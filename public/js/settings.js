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
      tables: draft.tables.map(function (t) { return { no: Number(t.no), seats: Number(t.seats), area: String(t.area || "").trim(), x: t.x, y: t.y, shape: t.shape || "square" }; }),
      loyalty: { enabled: el("loyaltyOn").checked, earnPer100: number("earnPer100"), pointValue: number("pointValue") },
      bookings: { open: el("bookOpen").value, close: el("bookClose").value, slotMinutes: number("bookSlot"), durationMinutes: number("bookLength") },
      categories: draft.categories.map(function (c) { return { name: String(c.name || "").trim(), station: c.station }; }),
      orderTypes: { dineIn: el("typeDineIn").checked, takeaway: el("typeTakeaway").checked, delivery: el("typeDelivery").checked },
      serviceChargePct: number("serviceCharge"),
      online: { ordering: el("onlineOrdering").checked, qr: el("onlineQr").checked },
      requireShift: el("requireShift").checked
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
        if (key === "area" || key === "no") box.addEventListener("change", renderFloorEditor);
        return box;
      };
      body.appendChild(h("tr", null, [
        h("td", null, [input("no", { type: "number", min: "1", max: "999", inputmode: "numeric" })]),
        h("td", null, [input("seats", { type: "number", min: "1", max: "20", inputmode: "numeric" })]),
        h("td", null, [input("area", { type: "text", maxlength: "30", list: "areaList" })]),
        h("td", null, [(function () {
          const s = h("select", { class: "select input-sm", "aria-label": "Shape for row " + (i + 1) }, [["square", "Square"], ["round", "Round"], ["long", "Long (2 cells)"]].map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
          s.value = t.shape || "square";
          s.addEventListener("change", function () { t.shape = s.value; markDirty(); renderFloorEditor(); });
          return s;
        })()]),
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

  // The first empty cell in an area, for a newly added table
  function firstFree(area) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
      if (!draft.tables.some(function (t) { return t.area === area && t.y === y && x >= t.x && x < t.x + (t.shape === "long" ? 2 : 1); })) return [x, y];
    }
    return [0, 0];
  }

  let floorArea = null;
  function renderFloorEditor() {
    const tables = draft.tables.map(function (t) { return Object.assign(t, { no: Number(t.no), seats: Number(t.seats) }); });
    floorArea = FloorPlan.areaTabs(el("floorEditAreas"), tables, floorArea, function (a) { floorArea = a; renderFloorEditor(); });
    FloorPlan.render(el("floorEdit"), tables, { area: floorArea, editable: true, onMove: function (t, x, y) { t.x = x; t.y = y; markDirty(); renderFloorEditor(); } });
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
  ["typeDineIn", "typeTakeaway", "typeDelivery", "requireShift", "loyaltyOn", "bookSlot", "onlineOrdering", "onlineQr"].forEach(function (id) { el(id).addEventListener("change", markDirty); });
  ["earnPer100", "pointValue", "bookOpen", "bookClose", "bookLength"].forEach(function (id) { el(id).addEventListener("input", markDirty); });
  el("serviceCharge").addEventListener("input", markDirty);

  // Printable QR cards, one per table; a new code stops an old card from working
  el("showQr").addEventListener("click", async function () {
    const got = await CMS.attempt(function () { return Api.call("GET", "/tables/qr"); }, opsErr);
    if (!got) return;
    const sheet = h("div", { class: "qr-sheet", id: "qrSheet" }, got.tables.map(function (t) {
      return h("div", { class: "qr-card" }, [
        h("b", { text: Store.cafe().name }), h("img", { src: t.qr, alt: "QR code for table " + t.no, width: "160", height: "160" }),
        h("span", { class: "qr-table", text: "Table " + t.no }), h("small", { text: "Scan to see the menu and order" }),
        h("button", { type: "button", class: "btn btn-ghost btn-sm no-print", text: "New code", onclick: function () { resetQr(t.no); } })
      ]);
    }));
    CMS.formDialog({ id: "qrModal", icon: "grid", wide: true, title: "Table QR codes", sub: "Print these and put one on each table.", fields: [sheet, h("button", { type: "button", class: "btn btn-secondary", icon: "file", text: "Print", onclick: function () { window.print(); } })], okText: "Done", submit: async function () { return true; } });
  });
  async function resetQr(no) {
    const ok = await CMS.confirm({ title: "New code for table " + no + "?", message: "The old QR card stops working. Print the new one.", okText: "Make new code", icon: "grid" });
    if (!ok) return;
    if (await CMS.attempt(function () { return CMS.withStepUp(function () { return Api.call("POST", "/tables/" + no + "/qr", {}); }).then(function () { return true; }); })) {
      CMS.closeModal("qrModal"); el("showQr").click(); CMS.toast("Table " + no + " has a new code", "ok");
    }
  }

  el("addTable").addEventListener("click", function () {
    const next = draft.tables.reduce(function (m, t) { return Math.max(m, Number(t.no) || 0); }, 0) + 1;
    const lastArea = draft.tables.length ? draft.tables[draft.tables.length - 1].area : "Main hall";
    draft.tables.push({ no: next, seats: 4, area: lastArea, shape: "square", x: firstFree(lastArea)[0], y: firstFree(lastArea)[1] });
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
    renderFloorEditor();
    renderCategories();
    const loyalty = draft.loyalty || { enabled: true, earnPer100: 1, pointValue: 1 };
    const bookings = draft.bookings || { open: "10:00", close: "23:00", slotMinutes: 30, durationMinutes: 90 };
    const online = draft.online || { ordering: true, qr: true };
    el("onlineOrdering").checked = online.ordering; el("onlineQr").checked = online.qr;
    el("loyaltyOn").checked = loyalty.enabled; el("earnPer100").value = loyalty.earnPer100; el("pointValue").value = loyalty.pointValue;
    el("bookOpen").value = bookings.open; el("bookClose").value = bookings.close; el("bookSlot").value = String(bookings.slotMinutes); el("bookLength").value = bookings.durationMinutes;
    el("typeDineIn").checked = draft.orderTypes.dineIn;
    el("typeTakeaway").checked = draft.orderTypes.takeaway;
    el("typeDelivery").checked = draft.orderTypes.delivery;
    el("serviceCharge").value = draft.serviceChargePct || 0;
    el("requireShift").checked = Boolean(draft.requireShift);
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
