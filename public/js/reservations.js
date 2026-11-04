(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  let query = "", date = "", status = "all", current = null;
  const STATUS_CLASS = { Confirmed: "pill-preparing", Seated: "pill-ready", Completed: "pill-ready", Cancelled: "pill-cancelled" };

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("reservationSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); render(); });
    document.getElementById("queueDate").addEventListener("change", function (e) { date = e.target.value; render(); });
    document.getElementById("queueStatus").addEventListener("change", function (e) { status = e.target.value; render(); });
    document.getElementById("saveReservationStatus").addEventListener("click", saveStatus);
    render();
    Store.on(render);
  });

  function render() {
    const all = Store.reservations();
    ["All", "Confirmed", "Seated", "Completed"].forEach(function (key) {
      const id = "r" + key;
      const el = document.getElementById(id);
      if (el) el.textContent = key === "All" ? all.length : all.filter(function (r) { return r.status === key; }).length;
    });
    const rows = all.filter(function (r) {
      const haystack = (r.id + " " + r.name + " " + r.phone).toLowerCase();
      return (!query || haystack.indexOf(query) !== -1) && (!date || r.date === date) && (status === "all" || r.status === status);
    });
    const body = document.getElementById("reservationBody");
    body.innerHTML = "";
    if (!rows.length) {
      body.appendChild(h("tr", null, [h("td", { colspan: "6" }, [h("div", { class: "empty-state", style: "padding:28px", text: "No reservations match these filters." })])]));
      return;
    }
    rows.forEach(function (r) {
      body.appendChild(h("tr", null, [
        h("td", null, [h("b", { text: r.id }), h("div", { class: "muted small", text: "Created " + CMS.timeAgo(r.createdAt) })]),
        h("td", null, [h("b", { text: r.name }), h("div", { class: "muted small", text: r.phone })]),
        h("td", { class: "nowrap", text: r.date + " · " + r.time }),
        h("td", { text: String(r.party) }),
        h("td", null, [h("span", { class: "pill " + STATUS_CLASS[r.status], text: r.status })]),
        h("td", { class: "actions" }, [h("button", { class: "btn btn-secondary btn-sm", text: "View", onclick: function () { open(r.id); } })])
      ]));
    });
  }

  function open(id) {
    current = Store.reservations().find(function (r) { return r.id === id; });
    if (!current) return;
    document.getElementById("reservationDetailTitle").textContent = current.id + " · " + current.name;
    document.getElementById("reservationDetailSub").textContent = current.date + " at " + current.time + " · " + current.party + " guest" + (current.party === 1 ? "" : "s");
    const body = document.getElementById("reservationDetailBody");
    body.innerHTML = "";
    body.appendChild(h("div", { class: "form-grid" }, [
      h("div", { class: "field" }, [h("label", { text: "Mobile number" }), h("p", { text: current.phone })]),
      h("div", { class: "field" }, [h("label", { text: "Created by" }), h("p", { text: current.createdBy })]),
      h("div", { class: "field span-2" }, [h("label", { text: "Notes" }), h("p", { text: current.notes || "No notes provided." })]),
      h("div", { class: "field span-2" }, [h("label", { for: "detailStatus", text: "Update status" }), h("select", { class: "select", id: "detailStatus", disabled: current.status === "Completed" || current.status === "Cancelled" }, ["Confirmed", "Seated", "Completed", "Cancelled"].map(function (s) { return h("option", { value: s, text: s, selected: s === current.status }); }))])
    ]));
    document.getElementById("saveReservationStatus").disabled = current.status === "Completed" || current.status === "Cancelled";
    CMS.openModal("reservationDetail");
  }

  function saveStatus() {
    if (!current) return;
    const next = document.getElementById("detailStatus").value;
    const result = CMS.attempt(function () { return Store.updateReservation(current.id, next, me); });
    if (!result) return;
    CMS.closeModal("reservationDetail");
    CMS.toast(current.id + " marked " + next.toLowerCase(), "ok");
    current = null;
  }
})();
