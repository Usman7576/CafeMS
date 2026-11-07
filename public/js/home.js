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

  el("reserveForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = el("reserveErr"), ok = el("reserveOk");
    CMS.clearError(err);
    ok.classList.remove("show");
    const body = {
      name: el("rName").value, phone: el("rPhone").value, date: el("rDate").value, time: el("rTime").value,
      party: Number(el("rParty").value), notes: el("rNotes").value, website: el("rWebsite").value
    };
    if (!body.name.trim() || !body.phone.trim() || !body.date || !body.time) {
      CMS.attempt(function () { const x = new Error(); x.userMessage = "Please fill in your name, number, date and time."; throw x; }, err);
      return;
    }
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
