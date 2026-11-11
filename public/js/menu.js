// Menu management (Admin): add, edit, delete, switch items on/off, prices.
// All input is validated in the data layer; price changes are audit-logged.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  let cat = "All", query = "", editingId = null, rules = null, photoCheck = null;
  // Photos: PNG, JPEG or WebP, up to 2 MB, the same limit the server applies
  const PHOTO = {
    types: { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" },
    mimes: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: 2 * 1024 * 1024,
    label: "PNG, JPEG or WebP"
  };

  App.ready(function () {
    document.getElementById("menuSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); renderRows(); });
    document.getElementById("addItem").addEventListener("click", function () { openForm(null); });
    document.getElementById("itemForm").addEventListener("submit", save);
    rules = Validate.attach(document.getElementById("itemForm"), {
      fName: { label: "Item name", required: true, min: 2, max: 40, collapseSpaces: true },
      fCat: { label: "Category", required: true, requiredMessage: "Choose or enter a category.", min: 2, max: 24, collapseSpaces: true },
      fPrice: { label: "Price", required: true, number: { min: 50, max: 20000 } },
      fDesc: { label: "Description", max: 80, collapseSpaces: true }
    }, { summary: document.getElementById("itemErr") });
    photoCheck = Validate.attachFile(document.getElementById("fPhoto"), PHOTO);
    document.getElementById("addIngredient").addEventListener("click", function () { addRecipeRow(null); });
    const desc = document.getElementById("fDesc");
    desc.addEventListener("input", function () { document.getElementById("descCount").textContent = desc.value.length + " / 80"; });
    render();
    Store.on(render);
  });

  function render() { renderCats(); renderRows(); }

  function renderCats() {
    const menu = Store.menu(), cats = ["All"].concat(Store.categories());
    if (cats.indexOf(cat) === -1) cat = "All";
    const wrap = document.getElementById("catTabs");
    wrap.replaceChildren();
    cats.forEach(function (c) {
      const n = c === "All" ? menu.length : menu.filter(function (m) { return m.cat === c; }).length;
      wrap.appendChild(h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(c === cat), onclick: function () { cat = c; render(); } }, [c + " ", h("span", { class: "n", text: String(n) })]));
    });
    const dl = document.getElementById("catList");
    dl.replaceChildren();
    Store.categories().forEach(function (c) { dl.appendChild(h("option", { value: c })); });
  }

  function renderRows() {
    const rows = Store.menu().filter(function (m) { return (cat === "All" || m.cat === cat) && (!query || m.name.toLowerCase().indexOf(query) !== -1); });
    const body = document.getElementById("menuBody");
    body.replaceChildren();
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "6" }, [h("div", { class: "empty-state pad-28", text: "No menu items match." })])])); return; }
    rows.forEach(function (m) {
      const reason = Store.unavailableReason(m.id);
      const status = !reason ? ["Available", "pill-ready"] : m.available ? [reason, "pill-preparing"] : ["Hidden", "pill-served"];
      const sw = h("input", { type: "checkbox", class: "switch", "aria-label": (m.available ? "Hide " : "Show ") + m.name + " on the menu" });
      sw.checked = m.available;
      sw.addEventListener("change", async function () {
        const ok = await CMS.attempt(async function () { await Store.saveMenuItem(Object.assign({}, m, { available: sw.checked })); return true; });
        if (ok) CMS.toast(m.name + (sw.checked ? " is back on the menu" : " hidden from the menu"), "ok"); else sw.checked = !sw.checked;
      });
      body.appendChild(h("tr", null, [
        h("td", null, [h("div", { class: "person" }, [m.hasPhoto ? h("img", { class: "menu-thumb", src: Store.photoUrl(m.id), alt: "", loading: "lazy" }) : null, h("div", null, [h("b", { text: m.name }), h("small", { class: "sub-line", text: m.desc || "No description" })])])]),
        h("td", { class: "hide-sm", text: m.cat }),
        h("td", { class: "num nowrap", text: CMS.money(m.price) }),
        h("td", null, [h("span", { class: "pill " + status[1], text: status[0] })]),
        h("td", null, [sw]),
        h("td", { class: "actions" }, [h("div", { class: "row-actions" }, [
          h("button", { class: "btn btn-secondary btn-sm", text: "Edit", "aria-label": "Edit " + m.name, onclick: function () { openForm(m); } }),
          h("button", { class: "btn btn-ghost btn-sm icon-only", icon: "trash", iconSize: 15, "aria-label": "Delete " + m.name, title: "Delete", onclick: function () { remove(m); } })
        ])])
      ]));
    });
  }

  function addRecipeRow(line) {
    const stock = Store.inventory();
    const select = h("select", { class: "select", "aria-label": "Ingredient" }, stock.map(function (s) { return h("option", { value: String(s.id), text: s.name + " (" + s.unit + ")" }); }));
    if (line) select.value = String(line.ing);
    const qty = h("input", { class: "input", type: "number", min: "0.001", step: "0.001", "aria-label": "Quantity per portion", placeholder: "Per portion" });
    if (line) qty.value = line.qty;
    const row = h("div", { class: "recipe-row" }, [select, qty]);
    row.appendChild(h("button", { type: "button", class: "btn btn-ghost btn-sm icon-only", icon: "trash", iconSize: 15, "aria-label": "Remove ingredient", onclick: function () { row.remove(); } }));
    document.getElementById("recipeRows").appendChild(row);
  }

  function readRecipe() {
    return Array.prototype.map.call(document.querySelectorAll("#recipeRows .recipe-row"), function (row) {
      return { ing: Number(row.querySelector("select").value), qty: Number(row.querySelector("input").value) };
    });
  }

  function openForm(m) {
    editingId = m ? m.id : null;
    document.getElementById("recipeRows").replaceChildren();
    if (m) (m.recipe || []).forEach(addRecipeRow);
    CMS.clearError(document.getElementById("itemErr"));
    document.getElementById("itemTitle").textContent = m ? "Edit " + m.name : "Add menu item";
    rules.reset();
    photoCheck.reset();
    document.getElementById("fName").value = m ? m.name : "";
    document.getElementById("fCat").value = m ? m.cat : (cat !== "All" ? cat : "");
    document.getElementById("fPrice").value = m ? m.price : "";
    document.getElementById("fDesc").value = m ? m.desc : "";
    document.getElementById("fAvail").checked = m ? m.available : true;
    document.getElementById("descCount").textContent = (m ? m.desc.length : 0) + " / 80";
    CMS.openModal("itemModal");
    setTimeout(function () { document.getElementById("fName").focus(); }, 50);
  }

  async function save(e) {
    e.preventDefault();
    const checked = rules.check();
    // The photo is checked again here, in case it changed on disk after it was chosen
    const photoOk = await photoCheck.check();
    if (!checked.ok) return;
    if (!photoOk) { document.getElementById("fPhoto").focus(); return; }
    const v = checked.values;
    const data = {
      id: editingId, name: v.fName, cat: v.fCat, price: Number(v.fPrice),
      desc: v.fDesc, available: document.getElementById("fAvail").checked, recipeEdit: readRecipe()
    };
    const old = editingId ? Store.menuItem(editingId) : null;
    if (old && old.price !== data.price && Number.isInteger(data.price)) {
      const change = Math.round((data.price - old.price) / old.price * 100);
      if (Math.abs(change) >= 30) {
        const ok = await CMS.confirm({ title: "Large price change (" + (change > 0 ? "+" : "") + change + "%)", message: old.name + ": " + CMS.money(old.price) + " → " + CMS.money(data.price) + ". Please double-check. This will be recorded in the audit log.", okText: "Apply new price", icon: "alert" });
        if (!ok) return;
      }
    }
    const ok = await CMS.busy(e.submitter || document.getElementById("itemForm").querySelector("[type=submit]"), function () {
      return CMS.attempt(async function () {
        const saved = await Store.saveMenuItem(data);
        const photo = document.getElementById("fPhoto").files[0];
        if (photo) await Store.uploadPhoto(saved.id, photo);
        return true;
      }, document.getElementById("itemErr"));
    });
    if (!ok) return;
    CMS.closeModal("itemModal");
    CMS.toast(editingId ? "Menu item updated" : "Menu item added", "ok");
  }

  async function remove(m) {
    const ok = await CMS.confirm({ title: "Delete " + m.name + "?", message: "It will be removed from the menu for all staff. Past bills are not affected. This is recorded in the audit log.", okText: "Delete item", danger: true, icon: "trash" });
    if (ok && await CMS.attempt(async function () { await Store.deleteMenuItem(m.id); return true; })) CMS.toast(m.name + " deleted", "ok");
  }
})();
