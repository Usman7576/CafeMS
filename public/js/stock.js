// Stock tabs beyond the stock list (Manager): purchase orders and receiving, suppliers, stocktake and
// the waste log, plus adding and editing ingredients. Every amount is checked and worked out again by
// the server; this page only collects input and shows results.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  let tab = "tabStock", suppliers = [], orders = [], counts = [], waste = [];
  const money2 = function (n) { const v = Number(n || 0); return (v < 0 ? "−Rs " : "Rs ") + Math.abs(v).toLocaleString("en-PK", { maximumFractionDigits: 2 }); };
  const input = function (attrs, value) { const i = h("input", Object.assign({ class: "input" }, attrs)); if (value !== undefined && value !== null) i.value = value; return i; };

  App.ready(function () {
    document.querySelectorAll("#pageTabs .tab").forEach(function (t) {
      t.addEventListener("click", function () { show(t.getAttribute("data-tab")); });
    });
    el("addIngredient").addEventListener("click", function () { editIngredient(null); });
    el("newPo").addEventListener("click", function () { newOrder(); });
    const m = /^#(tab\w+)$/.exec(location.hash);
    if (m && el(m[1])) show(m[1]);
    load();
    Store.on(load);
  });

  function show(id) {
    tab = id;
    document.querySelectorAll("#pageTabs .tab").forEach(function (t) { t.setAttribute("aria-selected", String(t.getAttribute("data-tab") === id)); });
    document.querySelectorAll(".page-tab").forEach(function (p) { p.hidden = p.id !== id; });
    history.replaceState(null, "", id === "tabStock" ? location.pathname : "#" + id);
    render();
  }

  async function load() {
    const got = await CMS.attempt(async function () {
      return Promise.all([Api.call("GET", "/suppliers"), Api.call("GET", "/purchase-orders"), Api.call("GET", "/stock-counts"), Api.call("GET", "/waste")]);
    });
    if (!got) return;
    suppliers = got[0].suppliers; orders = got[1].orders; counts = got[2].counts; waste = got[3].waste;
    const open = orders.filter(function (o) { return o.status === "Ordered"; }).length;
    el("nOrders").textContent = open ? String(open) : "";
    render();
  }

  function render() {
    if (tab === "tabOrders") renderOrders();
    if (tab === "tabSuppliers") renderSuppliers();
    if (tab === "tabCounts") renderCounts();
    if (tab === "tabWaste") renderWaste();
  }

  function panel(title, sub, action, content) {
    return h("section", { class: "panel" }, [
      h("div", { class: "panel-head" }, [h("div", null, [h("h3", { text: title }), h("p", { text: sub })]), action]),
      content
    ]);
  }
  function table(headers, rows, empty) {
    return h("div", { class: "table-wrap flush" }, [h("table", { class: "data-table" }, [
      h("thead", null, [h("tr", null, headers.map(function (t) { return h("th", { text: t }); }))]),
      h("tbody", null, rows.length ? rows : [h("tr", null, [h("td", { colspan: String(headers.length), class: "muted", text: empty })])])
    ])]);
  }
  const supplierSelect = function (value, allowNone) {
    const s = h("select", { class: "select" }, (allowNone ? [h("option", { value: "", text: "No supplier" })] : []).concat(suppliers.filter(function (x) { return x.active || x.id === value; }).map(function (x) { return h("option", { value: x.id, text: x.name }); })));
    if (value) s.value = value;
    return s;
  };

  // ---------- Ingredients ----------
  function editIngredient(item) {
    const name = input({ maxlength: "40" }, item ? item.name : "");
    const unit = h("select", { class: "select" }, ["kg", "g", "L", "ml", "pcs"].map(function (u) { return h("option", { value: u, text: u }); }));
    if (item) { name.disabled = true; unit.value = item.unit; unit.disabled = true; }
    const reorder = input({ type: "number", min: "0", step: "0.1", inputmode: "decimal" }, item ? item.reorder : 1);
    const cost = input({ type: "number", min: "0", step: "0.01", inputmode: "decimal" }, item ? item.cost : "");
    const supplier = supplierSelect(item ? item.supplierId : "", true);
    CMS.formDialog({
      id: "ingredientModal", icon: "package", title: item ? "Edit " + item.name : "Add ingredient",
      sub: item ? "Receiving a purchase order updates the cost automatically, as an average." : "It starts at zero stock. Receive a purchase order to add some.",
      fields: [CMS.field("Name", name), CMS.field("Unit", unit), CMS.field("Reorder when below", reorder), CMS.field("Cost per unit (Rs)", cost), CMS.field("Supplier", supplier)],
      okText: item ? "Save" : "Add ingredient",
      submit: async function () {
        const body = { reorder: Number(reorder.value), cost: Number(cost.value), supplierId: supplier.value };
        if (item) await Api.call("PUT", "/inventory/" + item.id, body);
        else await Api.call("POST", "/inventory", Object.assign({ name: name.value.trim(), unit: unit.value }, body));
        CMS.toast(item ? item.name + " saved" : "Ingredient added", "ok");
        return true;
      }
    });
  }

  // ---------- Purchase orders ----------
  function renderOrders() {
    const rows = orders.map(function (o) {
      const pill = { Ordered: "pill-preparing", Received: "pill-ready", Cancelled: "pill-cancelled" }[o.status];
      const actions = h("div", { class: "row-actions" }, o.status === "Ordered" ? [
        h("button", { class: "btn btn-primary btn-sm", text: "Receive", onclick: function () { receive(o); } }),
        h("button", { class: "btn btn-ghost btn-sm", text: "Cancel", onclick: function () { cancelOrder(o); } })
      ] : [h("span", { class: "muted small", text: o.receivedAt ? "Received " + CMS.dateTime(o.receivedAt) : "" })]);
      return h("tr", null, [
        h("td", null, [h("span", { class: "mono", text: o.id })]), h("td", { text: o.supplier }),
        h("td", { class: "small", text: o.lines.map(function (l) { return l.packs + " × " + l.packSize + " " + l.unit + " " + l.name; }).join(", ") }),
        h("td", { class: "num nowrap", text: o.receivedTotal !== null ? money2(o.receivedTotal) : money2(o.total) }),
        h("td", { class: "time hide-sm", text: CMS.dateTime(o.createdAt) }),
        h("td", null, [h("span", { class: "pill " + pill, text: o.status })]),
        h("td", { class: "actions" }, [actions])
      ]);
    });
    el("tabOrders").replaceChildren(panel("Purchase orders", "Order in packs from a supplier; receiving adds the stock and updates each ingredient's average cost.",
      h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 15, text: "New order", onclick: function () { newOrder(); } }),
      table(["Order", "Supplier", "Items", "Total", "Created", "Status", ""], rows, "No purchase orders yet.")));
  }

  function newOrder() {
    if (!suppliers.some(function (s) { return s.active; })) { CMS.toast("Add a supplier first.", "err"); show("tabSuppliers"); return; }
    const inv = Store.inventory();
    const supplier = supplierSelect("", false);
    const lines = h("div", { class: "po-lines" });
    const total = h("div", { class: "po-total" });
    const notes = input({ maxlength: "200", placeholder: "Optional, for example delivery time" });
    const update = function () {
      const sum = Array.prototype.reduce.call(lines.children, function (s, row) { const i = row.querySelectorAll("input"); return s + Number(i[0].value || 0) * Number(i[2].value || 0); }, 0);
      total.textContent = "Order total: " + money2(sum);
    };
    // Low stock from this supplier is suggested first
    const addLine = function (ing) {
      const select = h("select", { class: "select", "aria-label": "Ingredient" }, inv.map(function (i) { return h("option", { value: String(i.id), text: i.name + " (" + i.unit + ")" }); }));
      if (ing) select.value = String(ing.id);
      const unitOf = function () { const i = inv.find(function (x) { return String(x.id) === select.value; }); return i ? i.unit : ""; };
      const packs = input({ type: "number", min: "1", step: "1", inputmode: "numeric", "aria-label": "Packs" }, 1);
      const size = input({ type: "number", min: "0.001", step: "0.001", inputmode: "decimal", "aria-label": "Pack size" }, 1);
      const sizeLabel = h("label", { class: "label", text: "Pack size (" + unitOf() + ")" });
      const price = input({ type: "number", min: "0", step: "0.01", inputmode: "decimal", "aria-label": "Price per pack" }, ing ? ing.cost : "");
      select.addEventListener("change", function () { sizeLabel.textContent = "Pack size (" + unitOf() + ")"; const i = inv.find(function (x) { return String(x.id) === select.value; }); if (i && !price.value) price.value = i.cost; update(); });
      [packs, size, price].forEach(function (x) { x.addEventListener("input", update); });
      const row = h("div", { class: "po-line" }, [
        h("div", { class: "field" }, [h("label", { class: "label", text: "Ingredient" }), select]),
        h("div", { class: "field" }, [h("label", { class: "label", text: "Packs" }), packs]),
        h("div", { class: "field" }, [sizeLabel, size]),
        h("div", { class: "field" }, [h("label", { class: "label", text: "Price per pack" }), price]),
        h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", "aria-label": "Remove line", onclick: function () { row.remove(); update(); } }, [App.I("trash", 15)])
      ]);
      lines.appendChild(row);
      update();
    };
    const suggest = function () {
      lines.replaceChildren();
      const low = inv.filter(function (i) { return i.supplierId === supplier.value && i.status !== "ok"; });
      (low.length ? low : [null]).forEach(addLine);
    };
    supplier.addEventListener("change", suggest);
    suggest();
    CMS.formDialog({
      id: "poModal", icon: "package", wide: true, title: "New purchase order", sub: "Items running low from this supplier are filled in for you.",
      fields: [CMS.field("Supplier", supplier), lines, h("button", { type: "button", class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 14, text: "Add item", onclick: function () { addLine(null); } }), total, CMS.field("Notes", notes)],
      okText: "Create order",
      submit: async function () {
        const body = {
          supplierId: supplier.value, notes: notes.value.trim(),
          lines: Array.prototype.map.call(lines.children, function (row) {
            const i = row.querySelectorAll("input");
            return { ing: Number(row.querySelector("select").value), packs: Number(i[0].value), packSize: Number(i[1].value), packCost: Number(i[2].value) };
          })
        };
        const po = await Api.call("POST", "/purchase-orders", body);
        CMS.toast(po.id + " created", "ok");
        show("tabOrders");
        load();
        return true;
      }
    });
  }

  function receive(o) {
    const rows = o.lines.map(function (l) {
      const packs = input({ type: "number", min: "0", step: "1", inputmode: "numeric", "aria-label": "Packs received of " + l.name }, l.packs);
      const price = input({ type: "number", min: "0", step: "0.01", inputmode: "decimal", "aria-label": "Price per pack of " + l.name }, l.packCost);
      return { l: l, packs: packs, price: price, row: h("div", { class: "po-line" }, [
        h("div", { class: "field" }, [h("span", { class: "label", text: l.name }), h("small", { class: "muted", text: "Ordered " + l.packs + " × " + l.packSize + " " + l.unit })]),
        h("div", { class: "field" }, [h("label", { class: "label", text: "Packs" }), packs]),
        h("div", { class: "field" }, [h("span", { class: "label", text: "Pack size" }), h("span", { text: l.packSize + " " + l.unit })]),
        h("div", { class: "field" }, [h("label", { class: "label", text: "Price per pack" }), price])
      ]) };
    });
    CMS.formDialog({
      id: "receiveModal", icon: "check", wide: true, title: "Receive " + o.id, sub: o.supplier + " · change anything that arrived differently.",
      fields: [h("div", { class: "po-lines" }, rows.map(function (r) { return r.row; }))],
      okText: "Add to stock",
      submit: async function () {
        await Api.call("POST", "/purchase-orders/" + encodeURIComponent(o.id) + "/receive", { lines: rows.map(function (r) { return { ing: r.l.ing, packs: Number(r.packs.value), packCost: Number(r.price.value) }; }) });
        CMS.toast(o.id + " received; stock updated", "ok");
        load();
        return true;
      }
    });
  }

  async function cancelOrder(o) {
    const ok = await CMS.confirm({ title: "Cancel " + o.id + "?", message: "Nothing will be added to stock. This is recorded in the audit log.", okText: "Cancel order", danger: true, icon: "x" });
    if (ok && await CMS.attempt(function () { return Api.call("POST", "/purchase-orders/" + encodeURIComponent(o.id) + "/cancel", {}); })) { CMS.toast(o.id + " cancelled", "ok"); load(); }
  }

  // ---------- Suppliers ----------
  function renderSuppliers() {
    const inv = Store.inventory();
    const rows = suppliers.map(function (s) {
      const items = inv.filter(function (i) { return i.supplierId === s.id; }).map(function (i) { return i.name; });
      return h("tr", { class: s.active ? "" : "dim" }, [
        h("td", null, [h("b", { text: s.name }), s.active ? null : h("small", { class: "sub-line", text: "Not in use" })]),
        h("td", { class: "nowrap", text: s.phone || "—" }), h("td", { class: "hide-sm", text: s.email || "—" }),
        h("td", { class: "hide-md muted small", text: items.join(", ") || "—" }),
        h("td", { class: "actions" }, [h("button", { class: "btn btn-ghost btn-sm", text: "Edit", onclick: function () { editSupplier(s); } })])
      ]);
    });
    el("tabSuppliers").replaceChildren(panel("Suppliers", "Who you buy from. Link each ingredient to its supplier with Edit on the Stock tab.",
      h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 15, text: "Add supplier", onclick: function () { editSupplier(null); } }),
      table(["Supplier", "Phone", "Email", "Supplies", ""], rows, "No suppliers yet.")));
  }

  function editSupplier(s) {
    const name = input({ maxlength: "60" }, s ? s.name : "");
    const phone = input({ maxlength: "20", inputmode: "tel" }, s ? s.phone : "");
    const email = input({ type: "email", maxlength: "100" }, s ? s.email : "");
    const notes = input({ maxlength: "200", placeholder: "For example: delivers Mon and Thu" }, s ? s.notes : "");
    const active = h("input", { type: "checkbox", class: "switch" });
    active.checked = s ? s.active : true;
    CMS.formDialog({
      id: "supplierModal", icon: "users", title: s ? "Edit " + s.name : "Add supplier",
      fields: [CMS.field("Name", name), CMS.field("Phone", phone), CMS.field("Email", email), CMS.field("Notes", notes), h("label", { class: "switch-row" }, [active, "In use"])],
      submit: async function () {
        const body = { name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(), notes: notes.value.trim(), active: active.checked };
        await Api.call(s ? "PUT" : "POST", "/suppliers" + (s ? "/" + encodeURIComponent(s.id) : ""), body);
        CMS.toast("Supplier saved", "ok");
        load();
        return true;
      }
    });
  }

  // ---------- Stocktake ----------
  function renderCounts() {
    const inv = Store.inventory().slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    const boxes = {};
    const rows = inv.map(function (i) {
      const box = input({ type: "number", min: "0", step: "0.001", inputmode: "decimal", class: "input input-sm count-input", "aria-label": "Counted " + i.name, placeholder: CMS.qty(i.qty) });
      boxes[i.id] = box;
      return h("tr", null, [h("td", null, [h("b", { text: i.name })]), h("td", { class: "num nowrap", text: CMS.qty(i.qty) + " " + i.unit }), h("td", null, [h("div", { class: "input-group" }, [box, h("span", { class: "addon", text: i.unit })])])]);
    });
    const note = input({ maxlength: "120", placeholder: "Optional, for example: weekly count" });
    const save = h("button", { class: "btn btn-primary", text: "Save count", onclick: function () {
      const list = Object.keys(boxes).filter(function (id) { return boxes[id].value !== ""; }).map(function (id) { return { ing: Number(id), counted: Number(boxes[id].value) }; });
      if (!list.length) { CMS.toast("Enter at least one count.", "err"); return; }
      CMS.busy(save, async function () {
        const result = await CMS.attempt(function () { return Api.call("POST", "/stock-counts", { counts: list, note: note.value.trim() }); });
        if (result) { CMS.toast(result.id + " saved · difference " + money2(result.value), result.value < 0 ? "err" : "ok"); load(); }
      });
    } });
    const history = counts.map(function (c) {
      const changed = c.lines.filter(function (l) { return l.diff !== 0; });
      return h("tr", null, [h("td", null, [h("span", { class: "mono", text: c.id })]), h("td", { class: "time", text: CMS.dateTime(c.at) }), h("td", { text: Store.staffName(c.by) || c.by }),
        h("td", { class: "small", text: changed.length ? changed.map(function (l) { return l.name + " " + (l.diff > 0 ? "+" : "") + l.diff + " " + l.unit; }).join(", ") : "All matched" }),
        h("td", { class: "num nowrap" + (c.value < 0 ? " text-danger" : ""), text: money2(c.value) })]);
    });
    el("tabCounts").replaceChildren(
      panel("Count the shelves", "Leave an item empty to skip it. What you enter replaces the system's figure, and any difference is valued at cost.", save,
        h("div", null, [table(["Item", "System says", "You counted"], rows, "No stock items."), h("div", { class: "panel-body" }, [CMS.field("Note", note)])])),
      h("div", { class: "mt-20" }),
      panel("Past counts", "Differences found at each count", null, table(["Count", "When", "By", "Differences", "Value"], history, "No counts yet."))
    );
  }

  // ---------- Waste ----------
  function renderWaste() {
    const total = waste.reduce(function (s, w) { return s + w.value; }, 0);
    const rows = waste.map(function (w) {
      return h("tr", null, [h("td", { class: "time", text: CMS.clock(new Date(w.at)) }), h("td", null, [h("b", { text: w.name })]), h("td", { class: "num nowrap", text: CMS.qty(w.qty) + " " + w.unit }),
        h("td", { text: w.reason }), h("td", { class: "hide-sm", text: (Store.staffName(w.by) || w.by) + " · " + w.role }), h("td", { class: "num nowrap", text: money2(w.value) })]);
    });
    el("tabWaste").replaceChildren(panel("Waste today · " + money2(total), "Logged by the kitchen, bar and managers. It leaves stock and is valued at cost.",
      h("button", { class: "btn btn-secondary btn-sm", icon: "trash", iconSize: 15, text: "Log waste", onclick: function () { window.Waste.open(); } }),
      table(["Time", "Item", "Quantity", "Reason", "By", "Value"], rows, "Nothing wasted today.")));
  }

  window.StockPage = { editIngredient: editIngredient };
})();
