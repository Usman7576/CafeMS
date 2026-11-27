// The cashier's shift and cash drawer, shown above the billing screen: open with a float, record cash
// in or out, and close by counting the drawer. Closing shows the Z-report, which can be printed.
// Every figure comes from the server; this screen only displays it.
(function () {
  if (!window.App) return;
  const h = CMS.h;
  const bar = document.getElementById("shiftBar");
  if (!bar) return;
  let shift = null;

  App.ready(function () {
    load();
    // A payment or cash movement changes the expected cash in the drawer
    Store.on(load);
  });

  async function load() {
    try { shift = await Store.shift(); } catch (e) { shift = null; }
    render();
  }

  function render() {
    bar.replaceChildren();
    if (!shift) {
      bar.className = "shift-bar closed";
      bar.append(
        h("div", { class: "shift-info" }, [h("span", { class: "icon-tile warn" }, [App.I("clock", 18)]), h("div", null, [
          h("b", { text: "No shift open" }),
          h("small", { text: Store.requireShift ? "Open your shift to take payments." : "Open a shift to track the cash in your drawer and get a Z-report." })
        ])]),
        h("button", { type: "button", class: "btn btn-primary btn-sm", text: "Open shift", onclick: openDialog })
      );
      return;
    }
    bar.className = "shift-bar";
    bar.append(
      h("div", { class: "shift-info" }, [h("span", { class: "icon-tile ok" }, [App.I("clock", 18)]), h("div", null, [
        h("b", { text: "Shift " + shift.id + " · open since " + CMS.clock(new Date(shift.openedAt)) }),
        h("small", { text: shift.bills + " bills · sales " + CMS.money(shift.sales) + (shift.tips ? " · tips " + CMS.money(shift.tips) : "") + " · cash in drawer " + CMS.money(shift.expected) })
      ])]),
      h("div", { class: "row-actions" }, [
        h("button", { type: "button", class: "btn btn-secondary btn-sm", text: "Cash in / out", onclick: cashDialog }),
        h("button", { type: "button", class: "btn btn-secondary btn-sm", text: "Close shift", onclick: closeDialog })
      ])
    );
  }

  // A small form in a modal, rebuilt each time it opens
  function dialog(id, title, sub, fields, okText, submit) {
    const err = h("div", { class: "alert alert-error", role: "alert" });
    const ok = h("button", { class: "btn btn-primary", type: "submit", text: okText });
    let modal = document.getElementById(id);
    if (modal) modal.remove();
    const form = h("form", { class: "modal", novalidate: true }, [
      h("div", { class: "modal-head" }, [h("div", { class: "icon-tile" }, [App.I("cash", 20)]), h("div", null, [h("h3", { text: title }), h("p", { text: sub })])]),
      h("div", { class: "modal-body" }, [err].concat(fields)),
      h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-secondary", type: "button", "data-close": id, text: "Cancel" }), ok])
    ]);
    modal = h("div", { class: "modal-backdrop", id: id, role: "dialog", "aria-modal": "true" }, [form]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      CMS.clearError(err);
      CMS.busy(ok, async function () {
        const result = await CMS.attempt(submit, err);
        if (result) { CMS.closeModal(id); modal.remove(); }
      });
    });
    document.body.appendChild(modal);
    CMS.openModal(id);
    const first = form.querySelector("input");
    if (first) first.focus();
  }
  const money = function (id, label, value) {
    const input = h("input", { class: "input", id: id, type: "number", min: "0", inputmode: "numeric", value: value === undefined ? "" : String(value) });
    return { input: input, field: h("div", { class: "field" }, [h("label", { class: "label", for: id, text: label }), h("div", { class: "input-group" }, [h("span", { class: "addon", text: "Rs" }), input])]) };
  };

  function openDialog() {
    const float = money("shiftFloat", "Cash in the drawer now (float)", 0);
    dialog("shiftOpenModal", "Open your shift", "Count the cash already in the drawer before the first sale.", [float.field], "Open shift", async function () {
      shift = await Store.openShift(Math.floor(Number(float.input.value) || 0));
      render();
      CMS.toast("Shift " + shift.id + " opened", "ok");
      return true;
    });
  }

  function cashDialog() {
    let type = "in";
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Cash in or out" }, [["in", "Cash in"], ["out", "Cash out"]].map(function (t) {
      const b = h("button", { type: "button", role: "radio", class: "seg-btn", "aria-checked": String(t[0] === type), text: t[1] });
      b.addEventListener("click", function () { type = t[0]; seg.querySelectorAll(".seg-btn").forEach(function (x) { x.setAttribute("aria-checked", String(x === b)); }); });
      return b;
    }));
    const amount = money("cashAmount", "Amount");
    const reason = h("input", { class: "input", id: "cashReason", maxlength: "60", placeholder: "For example: change from bank, paid milk supplier" });
    dialog("shiftCashModal", "Cash in or out", "Money added to or taken from the drawer that is not a sale.", [
      h("div", { class: "field" }, [seg]), amount.field, h("div", { class: "field" }, [h("label", { class: "label", for: "cashReason", text: "Reason" }), reason])
    ], "Record", async function () {
      shift = await Store.cashMovement(type, Math.floor(Number(amount.input.value) || 0), reason.value.trim());
      render();
      CMS.toast("Cash " + type + " recorded", "ok");
      return true;
    });
  }

  function closeDialog() {
    const counted = money("shiftCounted", "Cash you counted in the drawer");
    const note = h("input", { class: "input", id: "shiftNote", maxlength: "120", placeholder: "Optional note for the manager" });
    dialog("shiftCloseModal", "Close shift " + shift.id, "Count every note and coin in the drawer. The Z-report compares it with what should be there.", [
      counted.field, h("div", { class: "field" }, [h("label", { class: "label", for: "shiftNote", text: "Note" }), note])
    ], "Close shift", async function () {
      const report = await Store.closeShift(Math.floor(Number(counted.input.value) || 0), note.value.trim());
      shift = null;
      render();
      showZ(report);
      return true;
    });
  }

  // The Z-report: what the shift took, by method, and whether the drawer balanced
  function showZ(z) {
    const row = function (a, b, cls) { return h("div", { class: "r-row " + (cls || "") }, [h("span", { text: a }), h("span", { text: b })]); };
    const diff = z.overShort;
    const body = h("div", { class: "receipt", id: "zReport" }, [
      h("div", { class: "r-head" }, [h("b", { text: Store.cafe().name }), h("small", { text: "Z-REPORT · " + z.id }), h("small", { text: z.cashierName })]),
      h("div", { class: "r-sep" }),
      row("Opened", CMS.dateTime(z.openedAt)), row("Closed", CMS.dateTime(z.closedAt)),
      h("div", { class: "r-sep" }),
      row("Bills paid", String(z.bills)), row("Sales (excl. tips)", CMS.money(z.sales)),
      row("  Discounts", "− " + CMS.money(z.discounts)), z.service ? row("  Service charge", CMS.money(z.service)) : null, row("  Tax", CMS.money(z.tax)),
      row("Tips", CMS.money(z.tips)),
      h("div", { class: "r-sep" }),
      row("Cash", CMS.money(z.byMethod.Cash)), row("Card", CMS.money(z.byMethod.Card)), row("Mobile wallet", CMS.money(z.byMethod.Wallet)),
      z.refunds ? row("Refunds (" + z.refunds + ")", "− " + CMS.money(z.refundAmount)) : null,
      h("div", { class: "r-sep" }),
      row("Float", CMS.money(z.float)), row("Cash in", CMS.money(z.cashIn)), row("Cash out", "− " + CMS.money(z.cashOut)),
      z.cashRefunds ? row("Cash refunds", "− " + CMS.money(z.cashRefunds)) : null,
      row("Expected in drawer", CMS.money(z.expected), "r-total"), row("Counted", CMS.money(z.counted), "r-total"),
      h("div", { class: "z-result " + (diff === 0 ? "ok" : "bad"), text: diff === 0 ? "BALANCED" : diff > 0 ? "OVER BY " + CMS.money(diff) : "SHORT BY " + CMS.money(-diff) }),
      z.note ? h("p", { class: "r-foot", text: "Note: " + z.note }) : null
    ]);
    let modal = document.getElementById("zModal");
    if (modal) modal.remove();
    modal = h("div", { class: "modal-backdrop", id: "zModal", role: "dialog", "aria-modal": "true", "aria-label": "Z-report" }, [
      h("div", { class: "modal receipt-modal" }, [body, h("div", { class: "modal-actions no-print" }, [
        h("button", { class: "btn btn-secondary", "data-close": "zModal", text: "Close" }),
        h("button", { class: "btn btn-primary", icon: "file", text: "Print", onclick: function () { CMS.printArea("zReport"); } })
      ])])
    ]);
    document.body.appendChild(modal);
    CMS.openModal("zModal");
  }
})();
