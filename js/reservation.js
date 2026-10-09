(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  const now = new Date();
  const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

  document.addEventListener("DOMContentLoaded", function () {
    const date = document.getElementById("reservationDate");
    date.min = today;
    date.value = today;
    document.getElementById("reservationForm").addEventListener("submit", save);
    document.getElementById("reservationForm").addEventListener("reset", function () {
      setTimeout(function () { date.value = today; document.getElementById("partySize").value = "2"; CMS.clearError(document.getElementById("reservationErr")); }, 0);
    });
    renderRecent();
    Store.on(renderRecent);
  });

  function save(e) {
    e.preventDefault();
    const err = document.getElementById("reservationErr");
    CMS.clearError(err);
    const data = {
      name: document.getElementById("guestName").value,
      phone: document.getElementById("guestPhone").value,
      date: document.getElementById("reservationDate").value,
      time: document.getElementById("reservationTime").value,
      party: document.getElementById("partySize").value,
      notes: document.getElementById("reservationNotes").value
    };
    const name = data.name.trim();
    const phone = data.phone.trim();
    const date = data.date.trim();
    const time = data.time.trim();
    const party = Number(data.party);
    let validationMessage = "";
    if (!name) validationMessage = "Enter the guest name.";
    else if (name.length < 2) validationMessage = "Guest name must be at least 2 characters.";
    else if (!phone) validationMessage = "Enter the guest mobile number.";
    else if (!date) validationMessage = "Select a reservation date.";
    else if (!time) validationMessage = "Select a reservation time.";
    else if (!Number.isInteger(party) || party < 1 || party > 20) validationMessage = "Enter a party size from 1 to 20.";
    else if (data.notes.trim().length > 160) validationMessage = "Notes must be 160 characters or fewer.";
    if (validationMessage) {
      CMS.attempt(function () { const error = new Error(validationMessage); error.userMessage = validationMessage; throw error; }, err);
      return;
    }
    const result = CMS.attempt(function () { return Store.addReservation(data, me); }, err);
    if (!result) return;
    CMS.clearError(err);
    e.target.reset();
    CMS.toast(result.id + " created for " + result.name, "ok");
  }

  function renderRecent() {
    const root = document.getElementById("recentReservations");
    if (!root) return;
    root.innerHTML = "";
    const rows = Store.reservations().sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 6);
    if (!rows.length) {
      root.appendChild(h("div", { class: "empty-state", text: "No reservations yet. Create the first one." }));
      return;
    }
    rows.forEach(function (r) {
      root.appendChild(h("div", { class: "setting", style: "padding:12px 0;border-bottom:1px solid var(--line)" }, [
        h("div", null, [h("b", { text: r.name }), h("small", { text: r.id + " · " + r.date + " at " + r.time + " · " + r.party + " guest" + (r.party === 1 ? "" : "s") })]),
        h("span", { class: "pill " + (r.status === "Cancelled" ? "pill-cancelled" : r.status === "Completed" ? "pill-ready" : "pill-preparing"), text: r.status })
      ]));
    });
  }
})();
