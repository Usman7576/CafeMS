// Incoming guest orders, from the website and from table QR codes. Each waits here until someone
// accepts it (it goes to the kitchen and becomes theirs) or declines it with a reason the guest sees.
// Waiters see orders for tables; cashiers see takeaway and delivery.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const panel = document.getElementById("incomingPanel");
  if (!panel) return;
  const forTables = App.session.role === "Waiter";
  let list = [];
  let known = null;

  App.ready(function () {
    load();
    Store.on(load);
  });

  async function load() {
    const got = await Api.call("GET", "/orders/incoming").catch(function () { return null; });
    if (!got) return;
    list = got.orders.filter(function (o) { return forTables ? o.type === "dine-in" : o.type !== "dine-in"; });
    // A sound-free nudge when a new order arrives
    if (known) list.forEach(function (o) { if (known.indexOf(o.id) === -1) CMS.toast("New order " + o.id + " · " + o.label, "info"); });
    known = list.map(function (o) { return o.id; });
    render();
  }

  function render() {
    panel.hidden = !list.length;
    if (!list.length) { panel.replaceChildren(); return; }
    panel.replaceChildren(
      h("div", { class: "panel-head" }, [h("div", null, [h("h3", null, ["Incoming orders ", h("span", { class: "pill pill-bill no-dot", text: String(list.length) })]), h("p", { text: forTables ? "Ordered from a table's QR code" : "Ordered from the website" })])]),
      h("ul", { class: "ready-list" }, list.map(function (o) {
        const waited = Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000));
        return h("li", null, [
          h("span", { class: "tno warn", text: o.type === "dine-in" ? "T" + o.table : o.type === "delivery" ? "DL" : "TA" }),
          h("div", { class: "meta" }, [
            h("b", { text: o.id + " · " + o.label + " · " + CMS.money(o.totals.total) }),
            h("small", { text: o.items.map(function (i) { return i.qty + "× " + i.name + (i.options && i.options.length ? " (" + i.options.join(", ") + ")" : ""); }).join(", ") }),
            h("small", { text: (o.customer && o.customer.phone ? o.customer.phone + " · " : "") + (o.customer && o.customer.address ? o.customer.address + " · " : "") + (o.notes ? "Note: " + o.notes + " · " : "") + waited + " min ago" })
          ]),
          h("div", { class: "row-actions" }, [
            h("button", { class: "btn btn-primary btn-sm", text: "Accept", onclick: function (e) { accept(o, e.currentTarget); } }),
            h("button", { class: "btn btn-ghost btn-sm", text: "Decline", onclick: function () { decline(o); } })
          ])
        ]);
      }))
    );
  }

  function accept(o, button) {
    CMS.busy(button, async function () {
      const ok = await CMS.attempt(function () { return Api.call("POST", "/orders/" + encodeURIComponent(o.id) + "/accept", {}); });
      if (ok) { CMS.toast(o.id + " accepted and sent to the kitchen", "ok"); load(); }
    });
  }

  function decline(o) {
    const reason = h("input", { class: "input", maxlength: "80", placeholder: "For example: sold out, too busy, outside delivery area" });
    CMS.formDialog({
      id: "declineModal", icon: "x", danger: true, title: "Decline " + o.id + "?", sub: "The guest sees this reason on their tracking page. The stock is put back.",
      fields: [CMS.field("Reason", reason)], okText: "Decline order",
      submit: async function () {
        await Api.call("POST", "/orders/" + encodeURIComponent(o.id) + "/decline", { reason: reason.value.trim() });
        CMS.toast(o.id + " declined", "ok");
        load();
        return true;
      }
    });
  }
})();
