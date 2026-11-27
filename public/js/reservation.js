(function () {
  if (!window.App) return;
  const h = CMS.h;
  const now = new Date();
  const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

  App.ready(function () {
    const date = document.getElementById("reservationDate");
    date.min = today;
    date.value = today;
    formRules();
    document.getElementById("reservationForm").addEventListener("submit", save);
    document.getElementById("reservationForm").addEventListener("reset", function () {
      setTimeout(function () { date.value = today; document.getElementById("partySize").value = "2"; CMS.clearError(document.getElementById("reservationErr")); }, 0);
    });
    date.addEventListener("change", loadTimes);
    document.getElementById("partySize").addEventListener("change", loadTimes);
    loadTimes();
    renderRecent();
    Store.on(renderRecent);
  });

  // Only times with a free table are offered; the server checks again when the booking is saved
  async function loadTimes() {
    const select = document.getElementById("reservationTime");
    const day = document.getElementById("reservationDate").value, party = Number(document.getElementById("partySize").value);
    if (!day || !(party >= 1 && party <= 20)) return;
    const result = await Api.call("GET", "/reservations/availability?date=" + encodeURIComponent(day) + "&party=" + party).catch(function () { return null; });
    const keep = select.value;
    select.replaceChildren();
    const times = result ? result.times : [];
    if (!times.length) { select.appendChild(h("option", { value: "", text: "No times left on this day" })); return; }
    select.appendChild(h("option", { value: "", text: "Choose a time" }));
    times.forEach(function (t) { select.appendChild(h("option", { value: t.available ? t.time : "", disabled: !t.available, text: t.time + (t.available ? "" : " · full") })); });
    if (keep && times.some(function (t) { return t.time === keep && t.available; })) select.value = keep;
  }

  let rules = null;
  function formRules() {
    if (rules) return rules;
    rules = Validate.attach(document.getElementById("reservationForm"), {
      guestName: { label: "Guest name", required: true, min: 2, max: 60, format: "personName", collapseSpaces: true },
      guestPhone: { label: "Mobile number", required: true, max: 13, format: "mobile" },
      reservationDate: { label: "Reservation date", required: true, format: "date", notBefore: function () { return Validate.today(0); } },
      reservationTime: { label: "Reservation time", required: true, requiredMessage: "Choose a time." },
      partySize: { label: "Party size", required: true, number: { min: 1, max: 20 } },
      reservationNotes: { label: "Notes", max: 160, collapseSpaces: true }
    }, { summary: document.getElementById("reservationErr") });
    return rules;
  }

  async function save(e) {
    e.preventDefault();
    const err = document.getElementById("reservationErr");
    CMS.clearError(err);
    const checked = formRules().check();
    if (!checked.ok) return;
    const v = checked.values;
    const data = { name: v.guestName, phone: v.guestPhone, date: v.reservationDate, time: v.reservationTime, party: Number(v.partySize), notes: v.reservationNotes };
    const result = await CMS.busy(e.submitter || e.target.querySelector("[type=submit]"), function () {
      return CMS.attempt(function () { return Store.addReservation(data); }, err);
    });
    if (!result) return;
    CMS.clearError(err);
    e.target.reset();
    CMS.toast(result.id + " created for " + result.name, "ok");
  }

  function renderRecent() {
    const root = document.getElementById("recentReservations");
    if (!root) return;
    root.replaceChildren();
    const rows = Store.reservations().sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 6);
    if (!rows.length) {
      root.appendChild(h("div", { class: "empty-state", text: "No reservations yet. Create the first one." }));
      return;
    }
    rows.forEach(function (r) {
      root.appendChild(h("div", { class: "setting setting-row" }, [
        h("div", null, [h("b", { text: r.name }), h("small", { text: r.id + " · " + r.date + " at " + r.time + " · " + r.party + " guest" + (r.party === 1 ? "" : "s") })]),
        h("span", { class: "pill " + (r.status === "Cancelled" ? "pill-cancelled" : r.status === "Completed" ? "pill-ready" : "pill-preparing"), text: r.status })
      ]));
    });
  }
})();
