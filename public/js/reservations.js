(function () {
  if (!window.App) return;
  const h = CMS.h, canReveal = App.session.role === "Manager";
  let query = "", date = "", status = "all", current = null, phoneResults = null;
  const STATUS_CLASS = { Confirmed: "pill-preparing", Seated: "pill-ready", Completed: "pill-ready", Cancelled: "pill-cancelled" };

  App.ready(function () {
    document.getElementById("reservationSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); searchPhone(); render(); });
    document.getElementById("queueDate").addEventListener("change", function (e) { date = e.target.value; render(); });
    document.getElementById("queueStatus").addEventListener("change", function (e) { status = e.target.value; render(); });
    document.getElementById("saveReservationStatus").addEventListener("click", saveStatus);
    render();
    Store.on(render);
  });

  // Numbers are stored encrypted, so a full number is looked up on the server as an exact match
  async function searchPhone() {
    const digits = query.replace(/[\s-]/g, "");
    phoneResults = null;
    if (!/^03\d{9}$/.test(digits)) return;
    const found = await CMS.attempt(function () { return Store.searchReservationsByPhone(digits); });
    if (found && query.replace(/[\s-]/g, "") === digits) { phoneResults = found; render(); }
  }

  function render() {
    const all = Store.reservations();
    ["All", "Confirmed", "Seated", "Completed"].forEach(function (key) {
      const id = "r" + key;
      const el = document.getElementById(id);
      if (el) el.textContent = key === "All" ? all.length : all.filter(function (r) { return r.status === key; }).length;
    });
    const rows = (phoneResults || all).filter(function (r) {
      if (phoneResults) return (!date || r.date === date) && (status === "all" || r.status === status);
      const haystack = (r.id + " " + r.name + " " + r.phone).toLowerCase();
      return (!query || haystack.indexOf(query) !== -1) && (!date || r.date === date) && (status === "all" || r.status === status);
    });
    const body = document.getElementById("reservationBody");
    body.replaceChildren();
    if (!rows.length) {
      body.appendChild(h("tr", null, [h("td", { colspan: "6" }, [h("div", { class: "empty-state pad-28", text: "No reservations match these filters." })])]));
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
    body.replaceChildren();
    body.appendChild(h("div", { class: "form-grid" }, [
      h("div", { class: "field" }, [h("label", { text: "Mobile number" }), h("p", { text: current.phone }), canReveal ? h("button", { class: "btn btn-ghost btn-sm", type: "button", text: "Show full number", onclick: function () { const id = current.id; CMS.showPhone(function () { return Store.reservationPhone(id); }); } }) : null]),
      h("div", { class: "field" }, [h("label", { text: "Created by" }), h("p", { text: current.createdBy })]),
      h("div", { class: "field span-2" }, [h("label", { text: "Notes" }), h("p", { text: current.notes || "No notes provided." })]),
      h("div", { class: "field span-2" }, [h("label", { for: "detailStatus", text: "Update status" }), h("select", { class: "select", id: "detailStatus", disabled: current.status === "Completed" || current.status === "Cancelled" }, ["Confirmed", "Seated", "Completed", "Cancelled"].map(function (s) { return h("option", { value: s, text: s, selected: s === current.status }); }))])
    ]));
    document.getElementById("saveReservationStatus").disabled = current.status === "Completed" || current.status === "Cancelled";
    CMS.openModal("reservationDetail");
  }

  async function saveStatus(e) {
    if (!current) return;
    const next = document.getElementById("detailStatus").value;
    const result = await CMS.busy(e.currentTarget, function () {
      return CMS.attempt(function () { return Store.updateReservation(current.id, next); });
    });
    if (!result) return;
    CMS.closeModal("reservationDetail");
    CMS.toast(current.id + " marked " + next.toLowerCase(), "ok");
    current = null;
  }
})();
