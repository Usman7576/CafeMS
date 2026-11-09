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
    renderGraph(data.dependencies);
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

  const svg = function (tag, attrs, children) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { el.appendChild(c); });
    return el;
  };

  // Drawn with DOM calls, so it works under the strict content security policy
  function renderGraph(dep) {
    const box = { w: 92, h: 38 }, size = { w: 720, h: 440 };
    const centre = { x: size.w / 2, y: size.h / 2 };
    const place = {};
    dep.components.forEach(function (name, i) {
      const angle = (i / dep.components.length) * Math.PI * 2 - Math.PI / 2;
      place[name] = { x: centre.x + Math.cos(angle) * 290, y: centre.y + Math.sin(angle) * 165 };
    });
    const arrow = svg("marker", { id: "depArrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, [svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "dep-arrow" })]);
    const root = svg("svg", { viewBox: "0 0 " + size.w + " " + size.h, class: "dep-graph", role: "img", "aria-label": "Dependency graph of CafeMS services" }, [svg("defs", {}, [arrow])]);
    // Where a line from a node's centre leaves its box
    const edgeOf = function (from, to) {
      const dx = to.x - from.x, dy = to.y - from.y;
      const scale = Math.min((box.w / 2 + 4) / Math.abs(dx || 1), (box.h / 2 + 4) / Math.abs(dy || 1));
      return { x: from.x + dx * scale, y: from.y + dy * scale };
    };
    dep.edges.forEach(function (e) {
      const a = place[e.from], b = place[e.to];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      // Two services that call each other get two separate lines
      const offset = { x: -(b.y - a.y) / len * 7, y: (b.x - a.x) / len * 7 };
      const from = edgeOf(a, b), to = edgeOf(b, a);
      const line = svg("line", { x1: from.x + offset.x, y1: from.y + offset.y, x2: to.x + offset.x, y2: to.y + offset.y, class: "dep-line dep-line-" + e.line, "marker-end": "url(#depArrow)" });
      line.appendChild(svg("title", {}));
      line.firstChild.textContent = e.from + " to " + e.to + ": " + e.code + " (" + e.line + ")";
      root.appendChild(line);
    });
    dep.components.forEach(function (name) {
      const p = place[name];
      const rect = svg("rect", { x: p.x - box.w / 2, y: p.y - box.h / 2, width: box.w, height: box.h, rx: 10, class: "dep-node" + (dep.external.includes(name) ? " dep-node-external" : "") });
      const label = svg("text", { x: p.x, y: p.y + 5, "text-anchor": "middle", class: "dep-label" });
      label.textContent = name;
      root.appendChild(svg("g", {}, [rect, label]));
    });
    document.getElementById("depGraph").replaceChildren(root);
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
