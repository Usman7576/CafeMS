// Walk-in waitlist: who is waiting for a table, how long they were told, and how long they have
// actually waited. Seat a party at a table, or mark that they left. Numbers are shown masked and are
// deleted by the server once the party is seated or leaves.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const panel = document.getElementById("waitlistPanel");
  if (!panel) return;
  let list = [];

  App.ready(function () {
    load();
    Store.on(load);
    // The "waited" minutes tick on without a reload
    setInterval(render, 60000);
  });

  async function load() {
    const got = await Api.call("GET", "/waitlist").catch(function () { return null; });
    if (got) list = got.waitlist;
    render();
  }

  function render() {
    const waiting = list.filter(function (w) { return w.status === "Waiting"; });
    const rows = waiting.map(function (w) {
      const waited = Math.round((Date.now() - new Date(w.createdAt).getTime()) / 60000);
      const late = waited > w.quotedMinutes;
      return h("li", null, [
        h("span", { class: "tno " + (late ? "danger" : "warn"), text: String(w.party) }),
        h("div", { class: "meta" }, [h("b", { text: w.name }), h("small", { text: "Waiting " + waited + " min · told " + w.quotedMinutes + " min" + (w.phone ? " · " + w.phone : "") })]),
        h("div", { class: "row-actions" }, [
          h("button", { class: "btn btn-primary btn-sm", text: "Seat", onclick: function () { seat(w); } }),
          h("button", { class: "btn btn-ghost btn-sm", text: "Left", onclick: function () { left(w); } })
        ])
      ]);
    });
    panel.replaceChildren(
      h("div", { class: "panel-head" }, [
        h("div", null, [h("h3", null, ["Waitlist ", h("span", { class: "pill no-dot", text: String(waiting.length) })]), h("p", { text: "Walk-in guests waiting for a table" })]),
        h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 15, text: "Add guest", onclick: add })
      ]),
      waiting.length ? h("ul", { class: "ready-list" }, rows) : h("p", { class: "panel-body muted", text: "Nobody is waiting." })
    );
  }

  function add() {
    const name = h("input", { class: "input", maxlength: "40", autocomplete: "off" });
    const party = h("input", { class: "input", type: "number", min: "1", max: "20", value: "2", inputmode: "numeric" });
    const phone = h("input", { class: "input", type: "tel", maxlength: "13", placeholder: "Optional, to call them back" });
    const quoted = h("input", { class: "input", type: "number", min: "0", max: "240", value: "15", inputmode: "numeric" });
    CMS.formDialog({
      id: "waitAddModal", icon: "users", title: "Add to waitlist", sub: "Tell the guest roughly how long it will be.",
      fields: [CMS.field("Name", name), CMS.field("Guests", party), CMS.field("Mobile number", phone), CMS.field("Wait told (minutes)", quoted)],
      okText: "Add",
      submit: async function () {
        await Api.call("POST", "/waitlist", { name: name.value.trim(), party: Number(party.value), phone: phone.value.replace(/[\s-]/g, ""), quotedMinutes: Number(quoted.value) });
        CMS.toast(name.value.trim() + " added to the waitlist", "ok");
        load();
        return true;
      }
    });
  }

  function seat(w) {
    const table = h("select", { class: "select" }, [h("option", { value: "", text: "No table yet" })].concat(Store.TABLES.filter(function (t) { return t.seats >= w.party; }).map(function (t) {
      const st = Store.tableState(t.no);
      return h("option", { value: String(t.no), text: "T" + t.no + " · " + t.seats + " seats · " + st.label, disabled: st.state !== "free" });
    })));
    CMS.formDialog({
      id: "waitSeatModal", icon: "grid", title: "Seat " + w.name, sub: "Party of " + w.party + ". Free tables that fit are listed.",
      fields: [CMS.field("Table", table)], okText: "Seat",
      submit: async function () {
        await Api.call("POST", "/waitlist/" + encodeURIComponent(w.id) + "/seat", table.value ? { table: Number(table.value) } : {});
        CMS.toast(w.name + " seated", "ok");
        load();
        return true;
      }
    });
  }

  async function left(w) {
    const ok = await CMS.confirm({ title: w.name + " left?", message: "They will be taken off the waitlist.", okText: "Remove", icon: "users" });
    if (ok && await CMS.attempt(function () { return Api.call("POST", "/waitlist/" + encodeURIComponent(w.id) + "/left", {}); })) load();
  }
})();
