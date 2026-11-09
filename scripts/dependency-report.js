// Usage: npm run deps:report [-- <matrix.json>]
// Checks the dependency matrix codes, then prints degrees, what each failure stops, slows or delays,
// and the single points of failure.
const fs = require("fs");
const path = require("path");
const { report } = require("../server/lib/dependencies");

const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "docs", "security", "dependency-matrix.json"));
const model = JSON.parse(fs.readFileSync(file, "utf8"));
const result = report(model);
const label = (name) => (result.external.includes(name) ? `${name} (external)` : name);
const list = (items) => (items.length ? items.join(", ") : "-");

console.log(`Dependency report for ${path.basename(file)}\n`);
console.log("Matrix (rows call columns; 2 hard sync, 1 soft sync, 1A soft async):");
const width = Math.max(...model.components.map((c) => c.length)) + 2;
console.log("".padEnd(width) + model.components.map((c) => c.padEnd(width)).join(""));
model.matrix.forEach((row, i) => console.log(model.components[i].padEnd(width) + row.map((c) => String(c).padEnd(width)).join("")));

console.log("\nGraph edges (solid = 2, dashed = 1, dotted = 1A):");
for (const e of result.edges) console.log(`  ${e.from.padEnd(8)} -> ${e.to.padEnd(8)} ${e.code.padEnd(3)} ${e.line}`);

console.log("\nDegrees:");
for (const d of result.degrees) console.log(`  ${label(d.component).padEnd(18)} in ${d.inDegree}  out ${d.outDegree}  hard callers: ${list(d.hardCallers)}`);

console.log("\nIf a component fails:");
for (const i of result.impacts) console.log(`  ${label(i.failed).padEnd(18)} stops: ${list(i.stopped)} | degraded: ${list(i.degraded)} | delayed: ${list(i.delayed)}`);

console.log("\nSingle points of failure (their failure alone stops other components):");
for (const s of result.singlePointsOfFailure) console.log(`  ${s.component.padEnd(8)} stops ${s.stops.length}: ${s.stops.join(", ")}`);
