// Inventory (Manager): stock levels, low-stock alerts, restock and write-off.
(function () {
  if (!window.App) return;
  const h = CMS.h, me = App.session.user;
  let filter = "all", query = "", current = null, mode = "restock";

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("#stockTabs .tab").forEach(function (t) {
      t.addEventListener("click", function () {
        filter = t.getAttribute("data-f");
        document.querySelectorAll("#stockTabs .tab").forEach(function (x) { x.setAttribute("aria-selected", String(x === t)); });
        render();
      });
    });
    document.getElementById("stockSearch").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); render(); });
    document.getElementById("stockForm").addEventListener("submit", save);
    render();
    Store.on(render);
    const id = Number(new URLSearchParams(location.search).get("restock"));
    if (id) open(id, "restock");
  });

  function statusOf(i) { return i.qty <= 0 ? "out" : i.qty <= i.reorder ? "low" : "ok"; }
  const LABEL = { ok: ["In stock", "pill-ready"], low: ["Running low", "pill-preparing"], out: ["Out of stock", "pill-cancelled"] };

  function render() {
    const inv = Store.inventory();
    const counts = { ok: 0, low: 0, out: 0 };
    inv.forEach(function (i) { counts[statusOf(i)]++; });
    document.getElementById("kItems").textContent = inv.length;
    document.getElementById("kOk").textContent = counts.ok;
    document.getElementById("kLow").textContent = counts.low;
    document.getElementById("kOut").textContent = counts.out;
    const affected = Store.menu().filter(function (m) { return !Store.isAvailable(m.id) && m.available; }).length;
    document.getElementById("kOutSub").textContent = affected + " menu item" + (affected === 1 ? "" : "s") + " sold out";

    const rows = inv.filter(function (i) {
      const st = statusOf(i);
      return (filter === "all" || filter === st) && (!query || i.name.toLowerCase().indexOf(query) !== -1 || i.supplier.toLowerCase().indexOf(query) !== -1);
    }).sort(function (a, b) { const o = { out: 0, low: 1, ok: 2 }; return o[statusOf(a)] - o[statusOf(b)] || a.name.localeCompare(b.name); });

    const body = document.getElementById("stockBody");
    body.innerHTML = "";
    if (!rows.length) { body.appendChild(h("tr", null, [h("td", { colspan: "7" }, [h("div", { class: "empty-state", style: "padding:28px", text: "No stock items match." })])])); return; }
    rows.forEach(function (i) {
      const st = statusOf(i);
      const pct = Math.min(100, i.qty / (i.reorder * 3) * 100);
      const used = Store.usedIn(i.id);
      body.appendChild(h("tr", null, [
        h("td", null, [h("b", { class: "nowrap", text: i.name })]),
        h("td", { class: "num nowrap", text: CMS.qty(i.qty) + " " + i.unit }),
        h("td", { class: "hide-sm" }, [h("div", { class: "level", title: "Reorder at " + i.reorder + " " + i.unit }, [h("div", { class: "level-fill " + st, style: "width:" + Math.max(pct, 2) + "%" }), h("i", { class: "level-mark", style: "left:" + (100 / 3) + "%" })])]),
        h("td", null, [h("span", { class: "pill " + LABEL[st][1], text: LABEL[st][0] })]),
        h("td", { class: "hide-sm muted", text: i.supplier }),
        h("td", { class: "hide-md muted small", text: used.length ? used.join(", ") : "—" }),
        h("td", { class: "actions" }, [h("div", { class: "row-actions" }, [
          h("button", { class: "btn btn-secondary btn-sm", icon: "plus", iconSize: 14, text: "Restock", "aria-label": "Restock " + i.name, onclick: function () { open(i.id, "restock"); } }),
          h("button", { class: "btn btn-ghost btn-sm", text: "Write off", "aria-label": "Write off " + i.name, disabled: i.qty <= 0 ? true : null, onclick: function () { open(i.id, "writeoff"); } })
        ])])
      ]));
    });
  }

  function open(id, m) {
    current = Store.inventory().find(function (i) { return i.id === id; });
    if (!current) return;
    mode = m;
    CMS.clearError(document.getElementById("stockErr"));
    document.getElementById("stockTitle").textContent = (m === "restock" ? "Restock " : "Write off ") + current.name.toLowerCase();
    document.getElementById("stockSub").textContent = "Currently " + CMS.qty(current.qty) + " " + current.unit + " · reorder at " + current.reorder + " " + current.unit + " · " + current.supplier;
    document.getElementById("stockQtyLabel").textContent = m === "restock" ? "Quantity received" : "Quantity to remove";
    document.getElementById("stockUnit").textContent = current.unit;
    document.getElementById("stockQty").value = m === "restock" ? Math.max(current.reorder * 2 - current.qty, current.reorder) : "";
    document.getElementById("stockReason").value = m === "restock" ? "Delivery from " + current.supplier : "";
    document.getElementById("stockReason").placeholder = m === "restock" ? "e.g. Delivery from supplier" : "e.g. Expired, spilled, damaged";
    document.getElementById("stockSave").textContent = m === "restock" ? "Add stock" : "Write off";
    document.getElementById("stockSave").className = "btn " + (m === "restock" ? "btn-primary" : "btn-danger");
    CMS.openModal("stockModal");
    setTimeout(function () { document.getElementById("stockQty").select(); }, 50);
  }

  function save(e) {
    e.preventDefault();
    const qty = Number(document.getElementById("stockQty").value);
    const reason = document.getElementById("stockReason").value.trim();
    const errBox = document.getElementById("stockErr");
    if (!(qty > 0)) { CMS.attempt(function () { const x = new Error(); x.userMessage = "Enter a quantity greater than zero."; throw x; }, errBox); return; }
    const ok = CMS.attempt(function () { Store.adjustStock(current.id, mode === "restock" ? qty : -qty, reason, me); return true; }, errBox);
    if (!ok) return;
    CMS.closeModal("stockModal");
    CMS.toast(current.name + (mode === "restock" ? " restocked (+" : " written off (−") + qty + " " + current.unit + ")", "ok");
    if (location.search) history.replaceState(null, "", location.pathname);
  }
})();
