// Kitchen display system (KDS): live tickets in three columns with ticket
// timers. Kitchen staff see items and notes only — no prices or payments.
(function () {
  if (!window.App) return;
  const h = CMS.h;

  App.ready(function () {
    // While kitchen staff are signed in, the server pauses its kitchen simulation.
    render();
    Store.on(render);
    setInterval(updateTimers, 1000);
  });

  function elapsed(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  function ageClass(ts) { const m = (Date.now() - ts) / 60000; return m >= 15 ? "late" : m >= 8 ? "warm" : "fresh"; }

  async function act(o, status, label) {
    if (await CMS.attempt(function () { return Store.setTicketStatus(o.id, status); })) CMS.toast(o.id + " · " + label, "ok");
  }

  function ticket(o) {
    const col = o.status;
    const btn = col === "Placed"
      ? h("button", { class: "btn btn-dark btn-block", icon: "chef", text: "Start preparing", onclick: function () { act(o, "Preparing", "preparing"); } })
      : col === "Preparing"
        ? h("button", { class: "btn btn-success btn-block", icon: "bell", text: "Mark ready", onclick: function () { act(o, "Ready", "ready for pickup"); } })
        : h("div", { class: "kds-wait", icon: "clock", iconSize: 15, text: "Waiting for pickup" });
    const since = col === "Placed" ? o.createdAt : o.createdAt;
    return h("article", { class: "kds-ticket " + ageClass(since), "data-since": String(since), "aria-label": o.id + " for table " + o.table }, [
      h("header", null, [
        h("div", null, [h("span", { class: "kds-table", text: "Table " + o.table }), h("span", { class: "kds-id mono", text: o.id })]),
        h("span", { class: "kds-timer", "data-timer": String(since), text: elapsed(since) })
      ]),
      h("ul", { class: "kds-items" }, o.items.map(function (i) { return h("li", null, [h("b", { text: i.qty + "×" }), h("span", { text: i.name })]); })),
      o.notes ? h("div", { class: "kds-note", icon: "note", iconSize: 15 }, [h("span", { text: o.notes })]) : null,
      h("div", { class: "kds-meta", text: "Sent " + CMS.clock(new Date(o.createdAt)) }),
      btn
    ]);
  }

  function fill(listId, countId, orders, emptyText) {
    const list = document.getElementById(listId);
    list.replaceChildren();
    document.getElementById(countId).textContent = orders.length;
    if (!orders.length) list.appendChild(h("div", { class: "kds-empty", text: emptyText }));
    orders.forEach(function (o) { list.appendChild(ticket(o)); });
  }

  function render() {
    const all = Store.tickets();
    const placed = all.filter(function (o) { return o.status === "Placed"; });
    const prep = all.filter(function (o) { return o.status === "Preparing"; });
    const ready = all.filter(function (o) { return o.status === "Ready"; });
    fill("listNew", "nNew", placed, "No new tickets");
    fill("listPrep", "nPrep", prep, "Nothing on the stove");
    fill("listReady", "nReady", ready, "Nothing waiting at the pass");

    const open = placed.concat(prep);
    const oldest = open.length ? Math.min.apply(null, open.map(function (o) { return o.createdAt; })) : null;
    const stats = document.getElementById("kdsStats");
    stats.replaceChildren();
    [["In queue", String(open.length)], ["Oldest ticket", oldest ? elapsed(oldest) : "—"], ["At the pass", String(ready.length)]].forEach(function (s, i) {
      stats.appendChild(h("div", { class: "stat-chip" }, [h("small", { text: s[0] }), h("b", { text: s[1], "data-oldest": i === 1 && oldest ? String(oldest) : null })]));
    });
  }

  function updateTimers() {
    document.querySelectorAll("[data-timer]").forEach(function (el) {
      const ts = Number(el.getAttribute("data-timer"));
      el.textContent = elapsed(ts);
      const card = el.closest(".kds-ticket");
      if (card) { card.classList.remove("fresh", "warm", "late"); card.classList.add(ageClass(ts)); }
    });
    const o = document.querySelector("[data-oldest]");
    if (o) o.textContent = elapsed(Number(o.getAttribute("data-oldest")));
  }
})();
