// POS: take a dine-in, takeaway or delivery order. Category pills and photo tiles on the left, the
// order on the right. Items with options (size, milk...) open a short chooser. Prices shown here are
// for display only: the server works out every price from the menu when the order is saved.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  const TYPES = [
    { key: "dine-in", flag: "dineIn", label: "Dine-in", icon: "grid" },
    { key: "takeaway", flag: "takeaway", label: "Takeaway", icon: "package" },
    { key: "delivery", flag: "delivery", label: "Delivery", icon: "send" }
  ];
  let type = "dine-in", table = null, activeCat = "All", editing = null;
  let cart = []; // { key, id, name, unit, qty, chosen: [{ group, choice }], labels: [] }
  let pending = null; // item whose options are being chosen

  const lineKey = function (id, chosen) { return JSON.stringify([id, chosen.map(function (c) { return c.group + "\u0000" + c.choice; }).sort()]); };
  const dirty = function () { return cart.length > 0 && !editing; };

  App.ready(function () {
    const params = new URLSearchParams(location.search);
    const editId = params.get("edit");
    const allowed = TYPES.filter(function (t) { return Store.orderTypes()[t.flag]; });
    if (allowed.length && !allowed.some(function (t) { return t.key === type; })) type = allowed[0].key;

    if (editId) {
      const o = Store.order(editId);
      const canEdit = o && (o.status === "Held" || (o.status === "Placed" && Object.keys(o.stations || {}).every(function (s) { return o.stations[s] === "Placed"; })));
      if (!canEdit) {
        CMS.toast(o ? "Preparation of " + editId + " has started. Send a new order for extra items." : "Order not found.", "err");
      } else {
        editing = o;
        type = o.type;
        table = o.table;
        cart = o.items.map(function (i) {
          const chosen = i.chosen || [];
          return { key: lineKey(i.id, chosen), id: i.id, name: i.name, unit: i.price, qty: i.qty, chosen: chosen, labels: i.options || [] };
        });
        el("notes").value = o.notes || "";
        el("orderHeading").textContent = (o.status === "Held" ? "Held order " : "Edit ") + o.id;
        el("orderIntro").textContent = o.status === "Held" ? "Change it, then send it to the kitchen or keep it on hold." : "You can change it until preparation starts.";
        if (o.customer) { el("custName").value = o.customer.name; el("custName").disabled = true; el("custPhone").disabled = true; el("custAddress").disabled = true; el("custPhone").placeholder = o.customer.phone; el("custAddress").value = o.customer.address; }
      }
    } else {
      const q = parseInt(params.get("table"), 10);
      if (Store.TABLES.some(function (t) { return t.no === q; }) && Store.tableState(q).state !== "other") { type = "dine-in"; table = q; }
    }

    renderTypes(); renderTarget(); renderCats(); renderMenu(); renderCart(); updateCounter();

    const search = el("search");
    search.addEventListener("input", renderMenu);
    search.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.target.value = ""; renderMenu(); } });
    el("notes").addEventListener("input", updateCounter);
    el("clearBtn").addEventListener("click", clearOrder);
    el("sendBtn").addEventListener("click", function () { submit(false); });
    el("holdBtn").addEventListener("click", function () { submit(true); });
    el("optAdd").addEventListener("click", addWithOptions);

    Store.on(function () {
      renderTarget(); renderMenu();
      if (editing) {
        const o = Store.order(editing.id);
        if (!o || (o.status !== "Held" && o.status !== "Placed") || (o.status === "Placed" && Object.keys(o.stations || {}).some(function (s) { return o.stations[s] !== "Placed"; }))) {
          CMS.toast("Preparation of " + editing.id + " just started, so your changes can't be saved.", "err");
          editing = null; cart = []; location.replace(App.home);
        }
      }
    });
    window.addEventListener("beforeunload", function (e) { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
  });

  function updateCounter() {
    const n = el("notes").value.length;
    el("notesCounter").textContent = n + " / 120";
    el("notesCounter").classList.toggle("warn", n >= 105);
  }

  // ---------- Order type and where it goes ----------
  function renderTypes() {
    const wrap = el("types");
    wrap.replaceChildren();
    const allowed = TYPES.filter(function (t) { return Store.orderTypes()[t.flag]; });
    wrap.hidden = allowed.length < 2 && !editing;
    allowed.forEach(function (t) {
      wrap.appendChild(h("button", { type: "button", class: "seg-btn", role: "radio", "aria-checked": String(type === t.key), disabled: Boolean(editing), onclick: function () {
        type = t.key; renderTypes(); renderTarget(); renderCart();
      } }, [App.I(t.icon, 16), t.label]));
    });
  }

  function renderTarget() {
    el("tableStep").hidden = type !== "dine-in";
    el("customerStep").hidden = type === "dine-in";
    el("addressField").hidden = type !== "delivery";
    el("phoneOpt").hidden = type === "delivery";
    if (type !== "dine-in") return;
    const wrap = el("tablePicker");
    wrap.replaceChildren();
    Store.TABLES.forEach(function (t) {
      const st = Store.tableState(t.no);
      const isSel = table === t.no;
      const b = h("button", { class: "tbl " + st.state + (isSel ? " selected" : ""), type: "button", role: "radio", "aria-checked": String(isSel), "aria-label": "Table " + t.no + ", " + t.seats + " seats, " + st.label },
        [h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" })]);
      if (st.state === "other" || (editing && t.no !== editing.table)) b.disabled = true;
      else b.addEventListener("click", function () { table = t.no; renderTarget(); renderCart(); });
      wrap.appendChild(b);
    });
  }

  // ---------- Menu ----------
  function renderCats() {
    const wrap = el("cats");
    wrap.replaceChildren();
    const names = Store.categoryList().map(function (c) { return c.name; });
    Store.categories().forEach(function (c) { if (names.indexOf(c) === -1) names.push(c); });
    ["All"].concat(names).forEach(function (c) {
      wrap.appendChild(h("button", { type: "button", class: "pos-cat", role: "tab", "aria-selected": String(activeCat === c), text: c, onclick: function () { activeCat = c; renderCats(); renderMenu(); } }));
    });
  }

  function renderMenu() {
    const grid = el("menuGrid");
    const q = el("search").value.trim().toLowerCase();
    const items = Store.menu().filter(function (m) {
      return (activeCat === "All" || m.cat === activeCat) && (!q || m.name.toLowerCase().indexOf(q) !== -1 || (m.desc || "").toLowerCase().indexOf(q) !== -1);
    });
    grid.replaceChildren();
    if (!items.length) { grid.appendChild(h("div", { class: "empty-state", icon: "search", iconSize: 32 }, [h("b", { text: "Nothing matches" }), "Try another word or category."])); return; }
    items.forEach(function (m) {
      const inCart = cart.filter(function (l) { return l.id === m.id; }).reduce(function (s, l) { return s + l.qty; }, 0);
      const out = !m.available;
      const tile = h("button", { type: "button", class: "pos-tile" + (out ? " soldout" : "") + (inCart ? " picked" : ""), disabled: out, "aria-label": m.name + ", " + CMS.money(m.price) + (out ? ", " + m.reason : ""), onclick: function () { pick(m); } }, [
        m.hasPhoto ? h("img", { class: "pos-photo", src: Store.photoUrl(m.id), alt: "", loading: "lazy" }) : h("span", { class: "pos-photo none" }, [App.I("coffee", 26)]),
        h("span", { class: "pos-name", text: m.name }),
        h("span", { class: "pos-meta" }, [h("b", { text: CMS.money(m.price) }), out ? h("small", { class: "out", text: m.reason }) : (m.options && m.options.length ? h("small", { text: "Options" }) : null)]),
        inCart ? h("span", { class: "qty-badge", text: String(inCart) }) : null
      ]);
      grid.appendChild(tile);
    });
  }

  function pick(m) {
    if (m.options && m.options.length) return openOptions(m);
    addLine(m, [], []);
  }

  function addLine(m, chosen, labels, extra) {
    const key = lineKey(m.id, chosen);
    const found = cart.find(function (l) { return l.key === key; });
    if (found) found.qty = Math.min(99, found.qty + 1);
    else cart.push({ key: key, id: m.id, name: m.name, unit: m.price + (extra || 0), qty: 1, chosen: chosen, labels: labels });
    renderCart(); renderMenu();
  }

  // ---------- Options chooser ----------
  function openOptions(m) {
    pending = m;
    el("optTitle").textContent = m.name;
    el("optSub").textContent = CMS.money(m.price) + " · choose the options";
    el("optErr").classList.remove("show");
    const body = el("optBody");
    body.replaceChildren();
    m.options.forEach(function (g, gi) {
      const name = "opt-" + gi;
      body.appendChild(h("fieldset", { class: "opt-group" }, [
        h("legend", null, [g.name, h("span", { class: "opt", text: g.required ? (g.multi ? " · choose at least one" : " · choose one") : " · optional" })]),
        h("div", { class: "opt-choices" }, g.choices.map(function (c, ci) {
          const input = h("input", { type: g.multi ? "checkbox" : "radio", name: name, value: String(ci), id: name + "-" + ci });
          if (!g.multi && g.required && ci === 0) input.checked = true;
          return h("label", { class: "opt-choice", for: name + "-" + ci }, [input, h("span", { text: c.name }), h("small", { text: c.price ? "+" + CMS.money(c.price) : "" })]);
        }))
      ]));
    });
    CMS.openModal("optionsModal");
  }

  function addWithOptions() {
    const m = pending;
    if (!m) return;
    const chosen = [], labels = [];
    let extra = 0;
    for (let gi = 0; gi < m.options.length; gi++) {
      const g = m.options[gi];
      const picked = Array.from(document.querySelectorAll('input[name="opt-' + gi + '"]:checked')).map(function (i) { return g.choices[Number(i.value)]; });
      if (g.required && !picked.length) {
        el("optErr").replaceChildren(App.I("alert", 18), h("span", { text: "Choose a " + g.name.toLowerCase() + "." }));
        el("optErr").classList.add("show");
        return;
      }
      picked.forEach(function (c) { chosen.push({ group: g.name, choice: c.name }); labels.push(c.name); extra += c.price; });
    }
    CMS.closeModal("optionsModal");
    pending = null;
    addLine(m, chosen, labels, extra);
  }

  // ---------- The order ----------
  function totals() {
    return Store.totals(cart.map(function (l) { return { price: l.unit, qty: l.qty }; }), 0);
  }

  function renderCart() {
    const list = el("lines");
    list.replaceChildren();
    if (!cart.length) list.appendChild(h("li", { class: "pos-empty" }, [App.I("clipboard", 26), h("span", { text: "Tap an item to add it" })]));
    cart.forEach(function (l) {
      const step = function (d) { return function () { l.qty = Math.max(0, Math.min(99, l.qty + d)); if (!l.qty) cart = cart.filter(function (x) { return x !== l; }); renderCart(); renderMenu(); }; };
      list.appendChild(h("li", null, [
        h("div", { class: "nm" }, [h("span", { text: l.name }), l.labels.length ? h("small", { text: l.labels.join(", ") }) : null]),
        h("div", { class: "stepper" }, [
          h("button", { type: "button", "aria-label": "One less " + l.name, onclick: step(-1) }, [App.I("minus", 14)]),
          h("span", { text: String(l.qty) }),
          h("button", { type: "button", "aria-label": "One more " + l.name, onclick: step(1) }, [App.I("plus", 14)])
        ]),
        h("span", { class: "amt", text: CMS.money(l.unit * l.qty) })
      ]));
    });
    const t = totals();
    el("totals").replaceChildren(
      h("div", null, [h("span", { text: "Items (" + t.count + ")" }), h("span", { text: CMS.money(t.sub) })]),
      h("div", null, [h("span", { text: "Tax" }), h("span", { text: CMS.money(t.tax) })]),
      h("div", { class: "grand" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(t.total) })])
    );
    const target = type === "dine-in" ? (table ? "Table " + table : "choose a table") : (type === "takeaway" ? "takeaway" : "delivery");
    el("sendLabel").textContent = editing && editing.status === "Placed" ? "Update order" : "Send · " + target;
    el("holdBtn").hidden = Boolean(editing && editing.status === "Placed");
  }

  function clearOrder() {
    if (editing) { location.href = App.home; return; }
    cart = []; el("notes").value = ""; updateCounter(); renderCart(); renderMenu();
  }

  function fail(message) {
    el("posErr").replaceChildren(App.I("alert", 18), h("span", { text: message }));
    el("posErr").classList.add("show");
  }

  async function submit(hold) {
    el("posErr").classList.remove("show");
    if (!cart.length) return fail("Add at least one item.");
    const lines = cart.map(function (l) { return { id: l.id, qty: l.qty, options: l.chosen }; });
    const notes = el("notes").value;
    const button = hold ? el("holdBtn") : el("sendBtn");

    if (editing) {
      return CMS.busy(button, async function () {
        try {
          await Store.updateOrder(editing.id, lines, notes);
          if (editing.status === "Held" && !hold) await Store.send(editing.id);
          CMS.toast(editing.id + (editing.status === "Held" && !hold ? " sent" : " saved"), "ok");
          editing = null; cart = [];
          location.href = App.home;
        } catch (e) { fail(e.userMessage || "The order could not be saved."); }
      });
    }

    const body = { type: type, lines: lines, notes: notes, hold: hold };
    if (type === "dine-in") {
      if (!table) return fail("Choose a table.");
      body.table = table;
    } else {
      const name = el("custName").value.trim();
      const phone = el("custPhone").value.replace(/[\s-]/g, "");
      const address = el("custAddress").value.trim();
      if (name.length < 2) return fail("Enter the customer's name.");
      if (type === "delivery" && !/^03\d{9}$/.test(phone)) return fail("Enter the mobile number as 03XXXXXXXXX.");
      if (type === "takeaway" && phone && !/^03\d{9}$/.test(phone)) return fail("Enter the mobile number as 03XXXXXXXXX, or leave it empty.");
      if (type === "delivery" && address.length < 5) return fail("Enter the delivery address.");
      body.customer = { name: name, phone: phone, address: type === "delivery" ? address : "" };
    }
    return CMS.busy(button, async function () {
      try {
        const order = await Store.place(body);
        CMS.toast(order.id + (hold ? " is on hold" : " sent to the kitchen") + " · " + order.label, "ok");
        cart = []; table = null; el("notes").value = ""; ["custName", "custPhone", "custAddress"].forEach(function (id) { el(id).value = ""; });
        updateCounter(); renderTarget(); renderCart(); renderMenu();
      } catch (e) { fail(e.userMessage || "The order could not be sent."); }
    });
  }
})();
