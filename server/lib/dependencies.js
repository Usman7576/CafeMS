// Service dependency matrix, as taught in the course. Rows call columns:
//   2  = hard, sync:  must succeed now or the caller's flow stops
//   1  = soft, sync:  tried now; on failure the caller carries on degraded
//   1A = soft, async: queued for later; the caller does not wait
//   0  = no direct dependency
// From the matrix this module works out in- and out-degrees, how a failure spreads, and the single
// points of failure.

const CODES = Object.freeze(["2", "1", "1A", "0"]);
const STRENGTH = Object.freeze({ 2: "hard", 1: "soft", "1A": "async" });
// The graph notation from the slides: solid for hard sync, dashed for soft sync, dotted for soft async
const LINE = Object.freeze({ 2: "solid", 1: "dashed", "1A": "dotted" });

class MatrixError extends Error {}

function validate(model) {
  const { components, matrix } = model || {};
  if (!Array.isArray(components) || !components.length) throw new MatrixError("The matrix needs a list of components.");
  if (new Set(components).size !== components.length) throw new MatrixError("Component names must be unique.");
  if (!Array.isArray(matrix) || matrix.length !== components.length) throw new MatrixError("There must be one row per component.");
  matrix.forEach((row, i) => {
    if (!Array.isArray(row) || row.length !== components.length) throw new MatrixError(`Row ${components[i]} must have one cell per component.`);
    row.forEach((cell, j) => {
      if (!CODES.includes(String(cell))) throw new MatrixError(`${components[i]} -> ${components[j]} has "${cell}"; use 2, 1, 1A or 0.`);
      if (i === j && String(cell) !== "0") throw new MatrixError(`${components[i]} cannot depend on itself.`);
    });
  });
  for (const name of model.external || []) if (!components.includes(name)) throw new MatrixError(`External component ${name} is not in the matrix.`);
  return model;
}

function edges(model) {
  validate(model);
  const list = [];
  model.matrix.forEach((row, i) => row.forEach((cell, j) => {
    const code = String(cell);
    if (code !== "0") list.push({ from: model.components[i], to: model.components[j], code, strength: STRENGTH[code], line: LINE[code] });
  }));
  return list;
}

function degrees(model) {
  const all = edges(model);
  return model.components.map((name) => ({
    component: name,
    inDegree: all.filter((e) => e.to === name).length,
    outDegree: all.filter((e) => e.from === name).length,
    hardCallers: all.filter((e) => e.to === name && e.code === "2").map((e) => e.from)
  }));
}

// What happens to everything else when one component fails. A hard caller stops, and so does
// anything that hard-depends on it in turn. A soft caller carries on degraded, and an async caller
// carries on with its messages delayed; neither passes the failure further.
function failureImpact(model, failed) {
  if (!model.components.includes(failed)) throw new MatrixError(`Unknown component ${failed}.`);
  const all = edges(model);
  const stopped = new Set();
  const queue = [failed];
  while (queue.length) {
    const down = queue.shift();
    for (const e of all) {
      if (e.to === down && e.code === "2" && e.from !== failed && !stopped.has(e.from)) {
        stopped.add(e.from);
        queue.push(e.from);
      }
    }
  }
  const down = new Set([failed, ...stopped]);
  const pick = (code) => [...new Set(all.filter((e) => down.has(e.to) && e.code === code && !down.has(e.from)).map((e) => e.from))];
  return { failed, stopped: [...stopped], degraded: pick("1"), delayed: pick("1A") };
}

// A single point of failure: its failure alone stops at least one other component
function singlePointsOfFailure(model) {
  return model.components
    .map((name) => ({ component: name, ...failureImpact(model, name) }))
    .filter((impact) => impact.stopped.length > 0)
    .sort((a, b) => b.stopped.length - a.stopped.length)
    .map(({ component, stopped }) => ({ component, stops: stopped }));
}

function report(model) {
  return {
    edges: edges(model),
    degrees: degrees(model),
    impacts: model.components.map((name) => failureImpact(model, name)),
    singlePointsOfFailure: singlePointsOfFailure(model),
    external: model.external || []
  };
}

module.exports = { validate, edges, degrees, failureImpact, singlePointsOfFailure, report, MatrixError, CODES };
