// Draws the floor plan: each area is a 12 × 8 grid and each table sits on one cell (a long table takes
// two). In Settings the tables can be dragged to a new cell, or moved with the arrow keys; on the
// waiter's dashboard each table shows its state and can be tapped.
(function () {
  const h = CMS.h;
  const COLS = 12, ROWS = 8;

  function areasOf(tables) {
    const list = [];
    tables.forEach(function (t) { if (list.indexOf(t.area) === -1) list.push(t.area); });
    return list;
  }

  // options: { area, editable, onMove(table, x, y), decorate(button, table), onPick(table) }
  function render(container, tables, options) {
    const o = options || {};
    const here = tables.filter(function (t) { return t.area === o.area; });
    const grid = h("div", { class: "floor-plan" + (o.editable ? " editing" : ""), role: o.editable ? "application" : "group", "aria-label": "Floor plan: " + o.area + (o.editable ? ". Drag a table, or select it and use the arrow keys." : "") });
    const taken = function (x, y, except) {
      return here.some(function (t) {
        if (t === except) return false;
        const w = t.shape === "long" ? 2 : 1;
        return t.y === y && x >= t.x && x < t.x + w;
      });
    };
    if (o.editable) {
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
        grid.appendChild(h("div", { class: "drop-cell", "data-x": String(x), "data-y": String(y), css: { gridColumn: String(x + 1), gridRow: String(y + 1) } }));
      }
    }
    here.forEach(function (t) {
      const button = h("button", { type: "button", class: "tbl shape-" + (t.shape || "square"), css: { gridColumn: (t.x + 1) + " / span " + (t.shape === "long" ? 2 : 1), gridRow: String(t.y + 1) } },
        [h("b", { text: "T" + t.no }), h("small", { text: t.seats + " seats" })]);
      if (o.decorate) o.decorate(button, t);
      if (o.onPick && !o.editable) button.addEventListener("click", function () { o.onPick(t); });
      if (o.editable) {
        const move = function (x, y) {
          const w = t.shape === "long" ? 2 : 1;
          if (x < 0 || y < 0 || x + w > COLS || y >= ROWS) return false;
          for (let i = 0; i < w; i++) if (taken(x + i, y, t)) return false;
          o.onMove(t, x, y);
          return true;
        };
        button.setAttribute("aria-label", "Table " + t.no + ", column " + (t.x + 1) + ", row " + (t.y + 1));
        button.addEventListener("keydown", function (e) {
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (!d) return;
          e.preventDefault();
          if (move(t.x + d[0], t.y + d[1])) setTimeout(function () { const again = container.querySelector("[data-table='" + t.no + "']"); if (again) again.focus(); }, 0);
        });
        button.setAttribute("data-table", String(t.no));
        // Pointer drag: works with a mouse, a pen or a finger
        button.addEventListener("pointerdown", function (e) {
          e.preventDefault();
          button.setPointerCapture(e.pointerId);
          button.classList.add("dragging");
          let over = null;
          const track = function (ev) {
            const below = document.elementsFromPoint(ev.clientX, ev.clientY).find(function (n) { return n.classList && n.classList.contains("drop-cell"); });
            if (over && over !== below) over.classList.remove("over");
            over = below || null;
            if (over) over.classList.add("over");
          };
          const done = function () {
            button.classList.remove("dragging");
            button.removeEventListener("pointermove", track);
            button.removeEventListener("pointerup", done);
            button.removeEventListener("pointercancel", done);
            if (over) {
              over.classList.remove("over");
              const ok = move(Number(over.getAttribute("data-x")), Number(over.getAttribute("data-y")));
              if (!ok) CMS.toast("That spot is taken.", "err");
            }
          };
          button.addEventListener("pointermove", track);
          button.addEventListener("pointerup", done);
          button.addEventListener("pointercancel", done);
        });
      }
      grid.appendChild(button);
    });
    container.replaceChildren(grid);
  }

  // Area tabs above the plan; returns the chosen area
  function areaTabs(container, tables, current, onChange) {
    const areas = areasOf(tables);
    const area = areas.indexOf(current) === -1 ? areas[0] : current;
    container.replaceChildren(h("div", { class: "tabs floor-areas", role: "tablist", "aria-label": "Areas" }, areas.map(function (a) {
      return h("button", { type: "button", class: "tab", role: "tab", "aria-selected": String(a === area), text: a, onclick: function () { onChange(a); } });
    })));
    if (areas.length < 2) container.replaceChildren();
    return area;
  }

  window.FloorPlan = { render: render, areaTabs: areaTabs, areasOf: areasOf };
})();
