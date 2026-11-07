// Serves the risk register and dependency matrix to the Admin risk page. The files are read and
// checked once at start-up, and every score is worked out here, so a typed-in number can never drift
// from its ratings.
const fs = require("fs");
const path = require("path");
const { wses, wsesRange, rpn, rank, WSES_WEIGHTS, WSES_LEVELS } = require("../lib/risk");
const dependencies = require("../lib/dependencies");

const DOCS = path.join(__dirname, "..", "..", "docs", "security");

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DOCS, name), "utf8"));
}

function build(register, matrix) {
  const components = rank(
    register.components.map((c) => ({
      id: c.id, name: c.name, why: c.why, controls: c.controls, removed: c.after === null,
      before: { ratings: c.before, score: wses(c.before) },
      after: c.after ? { ratings: c.after, score: wses(c.after) } : null
    })),
    (c) => (c.after ? c.after.score : -1)
  );
  const failureModes = rank(
    register.failureModes.map((f) => ({
      id: f.id, component: f.component, failure: f.failure, effect: f.effect, action: f.action, tests: f.tests,
      before: { ...f.before, rpn: rpn(f.before) },
      after: { ...f.after, rpn: rpn(f.after) }
    })),
    (f) => f.after.rpn
  );
  return {
    reviewed: register.reviewed,
    method: { weights: WSES_WEIGHTS, levels: WSES_LEVELS, range: wsesRange() },
    components,
    failureModes,
    dependencies: { components: matrix.components, names: matrix.names, matrix: matrix.matrix, why: matrix.why, ...dependencies.report(matrix) }
  };
}

function createRiskService() {
  const data = build(loadJson("risk-register.json"), loadJson("dependency-matrix.json"));
  return {
    get: () => data,
    csvRows: () => [["Type", "ID", "Name", "Before", "After", "Action or controls"]]
      .concat(data.components.map((c) => ["Component (WSES)", c.id, c.name, c.before.score, c.after ? c.after.score : "removed", c.controls.join("; ")]))
      .concat(data.failureModes.map((f) => ["Failure mode (RPN)", f.id, f.failure, f.before.rpn, f.after.rpn, f.action]))
  };
}

module.exports = { createRiskService, build };
