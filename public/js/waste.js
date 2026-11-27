// "Log waste" for the kitchen, bar and managers: what was thrown away, how much and why. The list of
// items carries names and units only; the server values the waste at cost and takes it from stock.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  let choices = null;

  async function open() {
    if (!choices) {
      const got = await CMS.attempt(function () { return Api.call("GET", "/waste/choices"); });
      if (!got) return;
      choices = got.items;
    }
    const item = h("select", { class: "select" }, choices.map(function (c) { return h("option", { value: String(c.id), text: c.name }); }));
    const unit = h("span", { class: "addon", text: choices.length ? choices[0].unit : "" });
    item.addEventListener("change", function () { const c = choices.find(function (x) { return String(x.id) === item.value; }); unit.textContent = c ? c.unit : ""; });
    const qty = h("input", { class: "input", type: "number", min: "0.001", step: "0.001", inputmode: "decimal", id: "wasteQty" });
    const reason = h("input", { class: "input", maxlength: "60", placeholder: "For example: dropped, burnt, past its date" });
    CMS.formDialog({
      id: "wasteModal", icon: "trash", title: "Log waste", sub: "It is taken from stock and shows in the manager's waste report.",
      fields: [CMS.field("Item", item), h("div", { class: "field" }, [h("label", { class: "label", for: "wasteQty", text: "Quantity" }), h("div", { class: "input-group" }, [qty, unit])]), CMS.field("Reason", reason)],
      okText: "Log waste",
      submit: async function () {
        const w = await Api.call("POST", "/waste", { ing: Number(item.value), qty: Number(qty.value), reason: reason.value.trim() });
        CMS.toast("Logged: " + w.qty + " " + w.unit + " " + w.name, "ok");
        return true;
      }
    });
  }

  window.Waste = { open: open };
})();
