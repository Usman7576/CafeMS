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

  async function loadMenu() {
    const result = await Api.call("GET", "/public/menu").catch(function () { return null; });
    if (!result) {
      el("publicMenu").replaceChildren(h("p", { class: "muted", text: "Our menu is taking a moment to load. Please try again shortly." }));
      return;
    }
    items = result.items;
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
    rTime: { label: "Time", required: true, format: "time", timeFrom: "10:00", timeTo: "23:00" },
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
    ok.textContent = result.message;
    ok.classList.add("show");
  });

  el("rDate").min = today();
  el("rDate").value = today();
  loadInfo();
  loadMenu();
})();
