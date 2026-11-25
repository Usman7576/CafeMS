// A guest's tracking page: the order's progress, checked again every 15 seconds until it is finished.
// The link's token is the only key to the order, and the page shows no staff or contact details.
(function () {
  const h = CMS.h;
  const token = new URLSearchParams(location.search).get("t") || "";
  const STEPS = ["Pending", "Placed", "Preparing", "Ready", "Served"];
  const LABELS = { Pending: "Sent", Placed: "Accepted", Preparing: "Preparing", Ready: "Ready", Served: "Done" };
  let timer = null;

  async function load() {
    const body = document.getElementById("trackBody");
    let o;
    try {
      o = await Api.call("GET", "/public/orders/" + encodeURIComponent(token), undefined, { public: true });
    } catch (e) {
      body.replaceChildren(h("div", { class: "empty-state", icon: "alert", iconSize: 32 }, [h("b", { text: "We could not find that order" }), "Check the link, or call the cafe."]));
      clearInterval(timer);
      return;
    }
    document.getElementById("orderNo").textContent = o.id + " · " + o.label;
    const reached = STEPS.indexOf(o.status);
    const steps = o.status === "Cancelled" ? null : h("ol", { class: "track-steps" }, STEPS.map(function (s, i) {
      return h("li", { class: i < reached ? "done" : i === reached ? "now" : "" }, [h("span", { class: "dot" }), h("span", { text: LABELS[s] })]);
    }));
    // Parts that do not apply are left out, rather than passed on empty
    body.replaceChildren.apply(body, [
      h("h1", { class: "track-status", text: o.message }),
      o.reason ? h("p", { class: "alert alert-warn show", text: "Reason: " + o.reason }) : null,
      steps,
      h("div", { class: "summary mt-20" }, o.items.map(function (i) {
        return h("div", { class: "row" }, [h("span", { text: i.qty + " × " + i.name + (i.options.length ? " (" + i.options.join(", ") + ")" : "") }), h("span", { text: CMS.money(i.price * i.qty) })]);
      }).concat([h("div", { class: "row" }, [h("span", { class: "muted", text: "Tax" }), h("span", { text: CMS.money(o.totals.tax) })]), h("div", { class: "row total" }, [h("span", { text: o.paid ? "Paid" : o.status === "Cancelled" ? "Total" : "To pay" }), h("span", { text: CMS.money(o.totals.total) })])])),
      h("p", { class: "muted small mt-12", text: "Ordered " + CMS.dateTime(o.createdAt) + " · last update " + CMS.clock(new Date(o.updatedAt)) })
    ].filter(Boolean));
    // Nothing more will change once it is finished
    if ((o.status === "Served" && o.paid) || o.status === "Cancelled") clearInterval(timer);
  }

  load();
  timer = setInterval(load, 15000);
})();
