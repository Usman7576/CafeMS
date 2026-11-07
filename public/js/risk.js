// Admin risk register: WSES per component, FMEA per failure mode, and the dependency matrix.
// Every number comes from the server, which works it out from the ratings.
(function () {
  if (!window.App) return;
  const h = CMS.h;

  App.ready(function () {
    load();
    document.getElementById("riskCsv").addEventListener("click", function (e) {
      const button = e.currentTarget;
      CMS.busy(button, function () {
        return CMS.attempt(function () { return Api.download("/risk.csv", "risk-register-" + new Date().toISOString().slice(0, 10) + ".csv"); });
      });
    });
  });

  // Bands for colour only; the order always follows the score itself
  function band(score, high, medium) { return score >= high ? "pill-cancelled" : score >= medium ? "pill-preparing" : "pill-ready"; }
  function scorePill(score, high, medium) { return h("span", { class: "pill no-dot " + band(score, high, medium), text: String(score) }); }

  async function load() {
    const data = await CMS.attempt(function () { return Store.risk(); }, document.getElementById("riskErr"));
    if (!data) return;
    document.getElementById("riskSub").textContent = "Reviewed " + data.reviewed + ". Component exposure (WSES), failure modes (FMEA) and how a failure spreads between services.";
    const w = data.method.weights;
    document.getElementById("wsesHow").textContent = "Access × " + w.accessibility + " + Data × " + w.dataSensitivity + " + Incidents × " + w.pastIncidents + " + Complexity × " + w.complexity +
      ", with Low 1, Medium 3, High 5. Scores run from " + data.method.range.min + " to " + data.method.range.max + ".";
    renderWses(data.components);
    renderFmea(data.failureModes);
    renderMatrix(data.dependencies);
    renderImpacts(data.dependencies);
  }

  function renderWses(components) {
    const body = document.getElementById("wsesBody");
    body.replaceChildren();
    components.forEach(function (c) {
      const r = c.after ? c.after.ratings : null;
      body.appendChild(h("tr", null, [
        h("td", { class: "mono", text: c.after ? String(c.rank) : "–" }),
        h("td", null, [h("b", { text: c.name }), h("small", { class: "muted block", text: c.why })]),
        h("td", { class: "num" }, [scorePill(c.before.score, 30, 20)]),
        h("td", { class: "num" }, [c.after ? scorePill(c.after.score, 30, 20) : h("span", { class: "pill no-dot pill-served", text: "Removed" })]),
        h("td", { class: "hide-md", text: r ? [r.accessibility, r.dataSensitivity, r.pastIncidents, r.complexity].join(" · ") : "Route deleted" })
      ]));
    });
  }

  function renderFmea(modes) {
    const body = document.getElementById("fmeaBody");
    body.replaceChildren();
    const sod = function (x) { return x.severity + " × " + x.occurrence + " × " + x.detection; };
    modes.forEach(function (f) {
      body.appendChild(h("tr", null, [
        h("td", { class: "mono", text: f.id }),
        h("td", null, [h("b", { text: f.failure }), h("small", { class: "muted block", text: f.effect })]),
        h("td", { class: "num" }, [scorePill(f.before.rpn, 200, 80), h("small", { class: "muted block", text: sod(f.before) })]),
        h("td", { class: "num" }, [scorePill(f.after.rpn, 200, 80), h("small", { class: "muted block", text: sod(f.after) })]),
        h("td", { class: "hide-md", text: f.action })
      ]));
    });
  }

  function renderMatrix(dep) {
    const table = document.getElementById("depMatrix");
    table.replaceChildren();
    const external = dep.external || [];
    const head = h("tr", null, [h("th", { text: "Caller \\ Callee" })].concat(dep.components.map(function (c) { return h("th", { class: "num", title: dep.names[c], text: c + (external.includes(c) ? "*" : "") }); })));
    table.appendChild(h("thead", null, [head]));
    const body = h("tbody");
    dep.matrix.forEach(function (row, i) {
      body.appendChild(h("tr", null, [h("th", { title: dep.names[dep.components[i]], text: dep.components[i] })].concat(row.map(function (cell, j) {
        const why = dep.why[dep.components[i] + "->" + dep.components[j]];
        return h("td", { class: "num dep-" + String(cell).toLowerCase(), title: why || "", text: String(cell) });
      }))));
    });
    table.appendChild(body);
  }

  function renderImpacts(dep) {
    const list = document.getElementById("impactList");
    list.replaceChildren();
    const spof = {};
    dep.singlePointsOfFailure.forEach(function (s) { spof[s.component] = true; });
    const text = function (items) { return items.length ? items.join(", ") : "nothing"; };
    dep.impacts.forEach(function (i) {
      list.appendChild(h("li", null, [
        h("span", { class: "tno " + (spof[i.failed] ? "danger" : "ok"), icon: spof[i.failed] ? "alert" : "check", iconSize: 18 }),
        h("div", { class: "meta" }, [
          h("b", { text: (dep.names[i.failed] || i.failed) + (spof[i.failed] ? " · single point of failure" : "") }),
          h("small", { text: "Stops " + text(i.stopped) + " · degraded " + text(i.degraded) + " · delayed " + text(i.delayed) })
        ])
      ]));
    });
  }
})();
