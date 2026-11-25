// Public website: cafe details, live menu and the online reservation form.
(function () {
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  let items = [], activeCat = "All";

  function showRow(rowId, valueId, value) {
    const row = el(rowId);
    if (!value) { row.hidden = true; return; }
    row.hidden = false;
    el(valueId).textContent = value;
  }

  async function loadInfo() {
    const info = await Api.call("GET", "/public/info").catch(function () { return null; });
    if (!info) return;
    document.title = info.name + " — Coffee, food and a table for you";
    document.querySelectorAll("[data-cafe-name]").forEach(function (n) { n.textContent = info.name; });
    el("heroTagline").textContent = info.tagline;
    el("heroAbout").textContent = info.about;
    showRow("visitHoursRow", "visitHours", info.hours);
    showRow("visitAddressRow", "visitAddress", info.address);
    showRow("visitPhoneRow", "visitPhone", info.phone);
    if (/^[0-9+\-\s]+$/.test(info.phone)) el("visitPhone").setAttribute("href", "tel:" + info.phone.replace(/[^0-9+]/g, ""));
  }

  function renderCats() {
    const wrap = el("publicCats");
    wrap.replaceChildren();
    ["All"].concat(Array.from(new Set(items.map(function (m) { return m.cat; })))).forEach(function (c) {
      wrap.appendChild(h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(c === activeCat), text: c, onclick: function () { activeCat = c; renderCats(); renderMenu(); } }));
    });
  }

  function renderMenu() {
    const grid = el("publicMenu");
    grid.replaceChildren();
    items.filter(function (m) { return activeCat === "All" || m.cat === activeCat; }).forEach(function (m) {
      grid.appendChild(h("article", { class: "menu-card" + (m.available ? "" : " soldout") }, [
        m.hasPhoto ? h("img", { class: "menu-card-photo", src: "/api/v1/public/menu/" + m.id + "/photo", alt: "", loading: "lazy" }) : h("div", { class: "menu-card-art", "aria-hidden": "true" }),
        h("div", { class: "menu-card-body" }, [
          h("div", { class: "menu-card-top" }, [h("h3", { text: m.name }), h("span", { class: "price", text: CMS.money(m.price) })]),
          h("p", { text: m.desc }),
          m.available ? null : h("span", { class: "pill pill-cancelled", text: "Sold out today" })
        ])
      ]));
    });
  }

  // The hero shows photos of real items from the menu, a mix of categories where possible
  function renderHeroPhotos() {
    const slots = document.querySelectorAll("#heroPhotos .hero-photo");
    if (!slots.length) return;
    const withPhoto = items.filter(function (m) { return m.hasPhoto; });
    const picked = [];
    const cats = new Set();
    withPhoto.forEach(function (m) { if (picked.length < slots.length && !cats.has(m.cat)) { picked.push(m); cats.add(m.cat); } });
    withPhoto.forEach(function (m) { if (picked.length < slots.length && picked.indexOf(m) === -1) picked.push(m); });
    picked.forEach(function (m, i) {
      slots[i].replaceChildren(h("img", { src: "/api/v1/public/menu/" + m.id + "/photo", alt: "", decoding: "async" }));
    });
  }

  async function loadMenu() {
    const result = await Api.call("GET", "/public/menu").catch(function () { return null; });
    if (!result) {
      el("publicMenu").replaceChildren(h("p", { class: "muted", text: "Our menu is taking a moment to load. Please try again shortly." }));
      return;
    }
    items = result.items;
    renderHeroPhotos();
    renderCats();
    renderMenu();
  }

  function today() {
    const now = new Date();
    return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  }

  // Online booking form. The checks here match the server's, which repeats them all.
  const reserveRules = Validate.attach(el("reserveForm"), {
    rName: { label: "Your name", required: true, min: 2, max: 60, format: "personName", collapseSpaces: true },
    rPhone: { label: "Mobile number", required: true, max: 13, format: "mobile" },
    rDate: { label: "Date", required: true, format: "date", notBefore: today, notAfter: function () { return Validate.today(60); }, notAfterMessage: "Online bookings can be made up to 60 days ahead. Please call us for later dates." },
    rTime: { label: "Time", required: true, requiredMessage: "Choose a time." },
    rParty: { label: "Guests", required: true, number: { min: 1, max: 20 } },
    rNotes: { label: "Notes", max: 160, collapseSpaces: true }
  }, { summary: el("reserveErr") });

  el("reserveForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = el("reserveErr"), ok = el("reserveOk");
    CMS.clearError(err);
    ok.classList.remove("show");
    const checked = reserveRules.check();
    if (!checked.ok) return;
    const v = checked.values;
    const body = { name: v.rName, phone: v.rPhone, date: v.rDate, time: v.rTime, party: Number(v.rParty), notes: v.rNotes, website: el("rWebsite").value };
    const result = await CMS.busy(el("reserveBtn"), function () {
      return CMS.attempt(function () { return Api.call("POST", "/public/reservations", body, { public: true }); }, err);
    });
    if (!result) return;
    e.target.reset();
    el("rDate").value = today();
    loadTimes();
    ok.textContent = result.message;
    ok.classList.add("show");
  });

  // Only times with a free table are offered; the server checks again when the booking arrives
  async function loadTimes() {
    const select = el("rTime");
    const date = el("rDate").value, party = Number(el("rParty").value);
    if (!date || !(party >= 1 && party <= 20)) return;
    const result = await Api.call("GET", "/public/availability?date=" + encodeURIComponent(date) + "&party=" + party, undefined, { public: true }).catch(function () { return null; });
    const keep = select.value;
    select.replaceChildren();
    const times = result ? result.times : [];
    if (!times.length) { select.appendChild(h("option", { value: "", text: "No times left on this day" })); return; }
    select.appendChild(h("option", { value: "", text: "Choose a time" }));
    times.forEach(function (t) { select.appendChild(h("option", { value: t.available ? t.time : "", disabled: !t.available, text: t.time + (t.available ? "" : " · full") })); });
    if (keep && times.some(function (t) { return t.time === keep && t.available; })) select.value = keep;
  }
  el("rDate").addEventListener("change", loadTimes);
  el("rParty").addEventListener("change", loadTimes);

  // Feedback: stars, then an optional comment
  let rating = 0;
  const stars = el("stars");
  [1, 2, 3, 4, 5].forEach(function (n) {
    stars.appendChild(h("button", { type: "button", class: "star", "aria-label": n + " star" + (n === 1 ? "" : "s"), "aria-pressed": "false", text: "★", onclick: function () {
      rating = n;
      stars.querySelectorAll(".star").forEach(function (s, i) { s.classList.toggle("on", i < n); s.setAttribute("aria-pressed", String(i < n)); });
    } }));
  });
  el("feedbackForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = el("feedbackErr"), ok = el("feedbackOk");
    CMS.clearError(err);
    ok.classList.remove("show");
    if (!rating) { err.replaceChildren(h("span", { text: "Choose 1 to 5 stars." })); err.classList.add("show"); return; }
    const body = { rating: rating, comment: el("fComment").value.trim(), name: el("fName").value.trim(), bill: el("fBill").value.trim().toUpperCase(), website: el("fWebsite").value };
    const result = await CMS.busy(el("feedbackBtn"), function () {
      return CMS.attempt(function () { return Api.call("POST", "/public/feedback", body, { public: true }); }, err);
    });
    if (!result) return;
    e.target.reset();
    rating = 0;
    stars.querySelectorAll(".star").forEach(function (s) { s.classList.remove("on"); s.setAttribute("aria-pressed", "false"); });
    ok.textContent = result.message;
    ok.classList.add("show");
  });

  el("rDate").min = today();
  el("rDate").value = today();
  loadTimes();
  loadInfo();
  loadMenu();
})();
