// Ordering for guests: takeaway or delivery from the website, or dine-in after scanning the QR code on
// a table (?table=<code>). Prices here are for display only; the server prices every line from the menu.
// After ordering, the guest is sent to a private tracking page.
(function () {
  const h = CMS.h;
  const el = function (id) { return document.getElementById(id); };
  const tableCode = new URLSearchParams(location.search).get("table");
  let menu = [], cart = [], activeCat = "All", type = "takeaway", pending = null, info = null, taxRate = 0.16, tableNo = null;
  const keyOf = function (id, chosen) { return JSON.stringify([id, chosen.map(function (c) { return c.group + "\u0000" + c.choice; }).sort()]); };

  async function start() {
    const [ordering, menuRes, cafe] = await Promise.all([
      Api.call("GET", "/public/ordering", undefined, { public: true }).catch(function () { return null; }),
      Api.call("GET", "/public/menu", undefined, { public: true }).catch(function () { return null; }),
      Api.call("GET", "/public/info", undefined, { public: true }).catch(function () { return null; })
    ]);
    if (cafe) document.querySelectorAll("[data-cafe-name]").forEach(function (n) { n.textContent = cafe.name; });
    info = ordering;
    if (ordering) taxRate = ordering.taxRate;
    menu = menuRes ? menuRes.items : [];
    if (tableCode) {
      const t = await Api.call("GET", "/public/table/" + encodeURIComponent(tableCode), undefined, { public: true }).catch(function () { return null; });
      if (!t || !ordering || !ordering.qr) return closed(t ? "Ordering from the table is not available right now. Please ask a member of staff." : "This table code is not valid. Please ask a member of staff.");
      tableNo = t.table;
      type = "dine-in";
      el("orderWhere").textContent = "Table " + tableNo;
      el("guestTitle").textContent = "Order to table " + tableNo;
      el("nameField").querySelector("label").textContent = "Your name (optional)";
      el("phoneField").hidden = true;
      el("payHint").textContent = "A member of staff brings it to your table. You pay at the end of your visit.";
    } else if (!ordering || !ordering.open || (!ordering.takeaway && !ordering.delivery)) {
      return closed("Online ordering is closed right now. Please call us or visit.");
    } else if (!ordering.takeaway) type = "delivery";
    renderTypes(); renderCats(); renderMenu(); renderCart();
  }

  function closed(message) {
    el("closedNote").textContent = message;
    el("closedNote").classList.add("show");
    document.querySelector(".guest-pos").hidden = true;
  }

  function renderTypes() {
    const wrap = el("types");
    wrap.replaceChildren();
    if (tableNo) { wrap.hidden = true; return; }
    [["takeaway", "Takeaway", "package"], ["delivery", "Delivery", "send"]].filter(function (t) { return info[t[0]]; }).forEach(function (t) {
      wrap.appendChild(h("button", { type: "button", class: "seg-btn", role: "radio", "aria-checked": String(type === t[0]), onclick: function () {
        type = t[0]; renderTypes(); renderCart();
        el("addressField").hidden = type !== "delivery";
        el("payHint").textContent = type === "delivery" ? "You pay the rider in cash when it arrives. The cafe confirms your order first." : "You pay when you collect. The cafe confirms your order first.";
      } }, [Icons.node(t[2], 16), t[1]]));
    });
    el("addressField").hidden = type !== "delivery";
  }

  function renderCats() {
    const cats = ["All"].concat(Array.from(new Set(menu.map(function (m) { return m.cat; }))));
    el("cats").replaceChildren.apply(el("cats"), cats.map(function (c) {
      return h("button", { type: "button", class: "pos-cat", role: "tab", "aria-selected": String(c === activeCat), text: c, onclick: function () { activeCat = c; renderCats(); renderMenu(); } });
    }));
  }

  function renderMenu() {
    const grid = el("menuGrid");
    grid.replaceChildren();
    menu.filter(function (m) { return activeCat === "All" || m.cat === activeCat; }).forEach(function (m) {
      const inCart = cart.filter(function (l) { return l.id === m.id; }).reduce(function (s, l) { return s + l.qty; }, 0);
      grid.appendChild(h("button", { type: "button", class: "pos-tile" + (m.available ? "" : " soldout") + (inCart ? " picked" : ""), disabled: !m.available, "aria-label": m.name + ", " + CMS.money(m.price) + (m.available ? "" : ", sold out"), onclick: function () { pick(m); } }, [
        m.hasPhoto ? h("img", { class: "pos-photo", src: "/api/v1/public/menu/" + m.id + "/photo", alt: "", loading: "lazy" }) : h("span", { class: "pos-photo none" }, [Icons.node("coffee", 26)]),
        h("span", { class: "pos-name", text: m.name }),
        h("span", { class: "pos-meta" }, [h("b", { text: CMS.money(m.price) }), m.available ? (m.options && m.options.length ? h("small", { text: "Options" }) : null) : h("small", { class: "out", text: "Sold out" })]),
        inCart ? h("span", { class: "qty-badge", text: String(inCart) }) : null
      ]));
    });
  }

  function pick(m) { if (m.options && m.options.length) openOptions(m); else add(m, [], [], 0); }
  function add(m, chosen, labels, extra) {
    const key = keyOf(m.id, chosen);
    const found = cart.find(function (l) { return l.key === key; });
    if (found) found.qty = Math.min(20, found.qty + 1);
    else cart.push({ key: key, id: m.id, name: m.name, unit: m.price + extra, qty: 1, chosen: chosen, labels: labels });
    renderCart(); renderMenu();
  }

  function openOptions(m) {
    pending = m;
    el("optTitle").textContent = m.name;
    el("optSub").textContent = CMS.money(m.price);
    el("optErr").classList.remove("show");
    el("optBody").replaceChildren.apply(el("optBody"), m.options.map(function (g, gi) {
      return h("fieldset", { class: "opt-group" }, [h("legend", null, [g.name, h("span", { class: "opt", text: g.required ? (g.multi ? " · choose at least one" : " · choose one") : " · optional" })]),
        h("div", { class: "opt-choices" }, g.choices.map(function (c, ci) {
          const input = h("input", { type: g.multi ? "checkbox" : "radio", name: "opt-" + gi, value: String(ci), id: "opt-" + gi + "-" + ci });
          if (!g.multi && g.required && ci === 0) input.checked = true;
          return h("label", { class: "opt-choice", for: "opt-" + gi + "-" + ci }, [input, h("span", { text: c.name }), h("small", { text: c.price ? "+" + CMS.money(c.price) : "" })]);
        }))]);
    }));
    CMS.openModal("optionsModal");
  }
  el("optAdd").addEventListener("click", function () {
    const m = pending;
    const chosen = [], labels = [];
    let extra = 0;
    for (let gi = 0; gi < m.options.length; gi++) {
      const g = m.options[gi];
      const picked = Array.from(document.querySelectorAll('input[name="opt-' + gi + '"]:checked')).map(function (i) { return g.choices[Number(i.value)]; });
      if (g.required && !picked.length) { el("optErr").textContent = "Choose a " + g.name.toLowerCase() + "."; el("optErr").classList.add("show"); return; }
      picked.forEach(function (c) { chosen.push({ group: g.name, choice: c.name }); labels.push(c.name); extra += c.price; });
    }
    CMS.closeModal("optionsModal");
    add(m, chosen, labels, extra);
  });

  function renderCart() {
    const list = el("lines");
    list.replaceChildren();
    if (!cart.length) list.appendChild(h("li", { class: "pos-empty" }, [Icons.node("coffee", 26), h("span", { text: "Your order is empty" })]));
    cart.forEach(function (l) {
      const step = function (d) { return function () { l.qty = Math.max(0, Math.min(20, l.qty + d)); if (!l.qty) cart = cart.filter(function (x) { return x !== l; }); renderCart(); renderMenu(); }; };
      list.appendChild(h("li", null, [
        h("div", { class: "nm" }, [h("span", { text: l.name }), l.labels.length ? h("small", { text: l.labels.join(", ") }) : null]),
        h("div", { class: "stepper" }, [h("button", { type: "button", "aria-label": "One less " + l.name, onclick: step(-1) }, [Icons.node("minus", 14)]), h("span", { text: String(l.qty) }), h("button", { type: "button", "aria-label": "One more " + l.name, onclick: step(1) }, [Icons.node("plus", 14)])]),
        h("span", { class: "amt", text: CMS.money(l.unit * l.qty) })
      ]));
    });
    const sub = cart.reduce(function (s, l) { return s + l.unit * l.qty; }, 0);
    const tax = Math.round(sub * taxRate);
    el("totals").replaceChildren(
      h("div", null, [h("span", { text: "Items" }), h("span", { text: CMS.money(sub) })]),
      h("div", null, [h("span", { text: "Tax" }), h("span", { text: CMS.money(tax) })]),
      h("div", { class: "grand" }, [h("span", { text: "Total" }), h("span", { text: CMS.money(sub + tax) })])
    );
    el("cartSub").textContent = cart.length ? cart.reduce(function (s, l) { return s + l.qty; }, 0) + " items" : "Tap an item to add it.";
    el("placeBtn").disabled = !cart.length;
  }

  function fail(message) { el("orderErr").textContent = message; el("orderErr").classList.add("show"); }

  el("placeBtn").addEventListener("click", function () {
    el("orderErr").classList.remove("show");
    const name = el("gName").value.trim(), phone = el("gPhone").value.replace(/[\s-]/g, ""), address = el("gAddress").value.trim();
    if (!tableNo) {
      if (name.length < 2) return fail("Please enter your name.");
      if (!/^03\d{9}$/.test(phone)) return fail("Please enter your mobile number as 03XXXXXXXXX.");
      if (type === "delivery" && address.length < 5) return fail("Please enter the delivery address.");
    }
    const body = {
      customer: tableNo ? { name: name } : { name: name, phone: phone, address: type === "delivery" ? address : "" },
      lines: cart.map(function (l) { return { id: l.id, qty: l.qty, options: l.chosen }; }), notes: el("gNotes").value.trim(), website: el("gWebsite").value
    };
    if (tableNo) body.tableCode = tableCode; else body.type = type;
    CMS.busy(el("placeBtn"), async function () {
      try {
        const result = await Api.call("POST", "/public/orders", body, { public: true });
        cart = [];
        // Only ever go to this site's own tracking page, never an address taken from the response as-is
        const token = typeof result.track === "string" ? (result.track.match(/^\/track\.html\?t=([A-Za-z0-9_-]{16,128})$/) || [])[1] : null;
        if (token) location.assign("/track.html?t=" + encodeURIComponent(token));
      } catch (e) { fail(e.userMessage || "Your order could not be sent. Please try again."); }
    });
  });

  // Enter in a field places the order the same way, never as a normal form submission
  el("detailsForm").addEventListener("submit", function (e) { e.preventDefault(); el("placeBtn").click(); });

  start();
})();
