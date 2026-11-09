// Usage: npm run concepts            checks every link and rewrites docs/security/CONCEPT-COVERAGE.md
//        npm run concepts -- --check checks only, and fails if the file is out of date
// Every lecture concept must name files that exist; anything marked Built must name tests that exist.
const fs = require("fs");
const path = require("path");
const { testTitles } = require("./check-traceability");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "docs", "security", "concept-coverage.json");
const OUTPUT = path.join(ROOT, "docs", "security", "CONCEPT-COVERAGE.md");
const STATUSES = ["Built", "Documented", "Manual", "Out of scope"];
const DECKS = ["SSD Lec1", "Week 2", "Week 4", "Attackers", "WSES", "FMEA", "Dependency Matrix", "Failures"];

function check(data, titles = testTitles()) {
  const problems = [];
  const seen = new Set();
  for (const c of data.concepts) {
    const label = `${c.deck}: ${c.concept}`;
    if (seen.has(label)) problems.push(`${label} is listed twice`);
    seen.add(label);
    if (!DECKS.includes(c.deck)) problems.push(`${label}: unknown deck`);
    if (!STATUSES.includes(c.status)) problems.push(`${label}: unknown status "${c.status}"`);
    if (!c.how) problems.push(`${label}: says nothing about how`);
    if (!c.files || !c.files.length) problems.push(`${label}: names no file`);
    for (const file of c.files || []) if (!fs.existsSync(path.join(ROOT, file))) problems.push(`${label}: ${file} does not exist`);
    for (const t of c.tests || []) if (!titles.has(t)) problems.push(`${label}: no test named "${t}"`);
    const reviewOnly = c.concept === "Code review";
    if (c.status === "Built" && !(c.tests || []).length && !reviewOnly) problems.push(`${label}: marked Built but names no test`);
  }
  for (const deck of DECKS) if (!data.concepts.some((c) => c.deck === deck)) problems.push(`No concepts listed for ${deck}`);
  return problems;
}

const cell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function render(data) {
  const count = (status) => data.concepts.filter((c) => c.status === status).length;
  const lines = [
    "# Concept coverage",
    "",
    `**All ${data.concepts.length} concepts from the eight lecture decks are accounted for: ${count("Built")} built and tested, ${count("Documented")} written analyses, ${count("Manual")} manual procedure and ${count("Out of scope")} that cannot be built inside a web app.**`,
    "",
    "Generated from `concept-coverage.json` by `npm run concepts`; do not edit by hand. A test fails if a file or test named here stops existing, or if this page is out of date.",
    ""
  ];
  for (const deck of DECKS) {
    lines.push(`## ${deck}`, "", "| Slide | Concept | Status | How CafeMS does it | Where | Proved by |", "| --- | --- | --- | --- | --- | --- |");
    for (const c of data.concepts.filter((x) => x.deck === deck)) {
      lines.push(`| ${cell(c.slide)} | ${cell(c.concept)} | ${c.status} | ${cell(c.how)} | ${c.files.map((f) => `\`${f}\``).join(", ")} | ${cell((c.tests || []).join("; ")) || "–"} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function run(args) {
  const data = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const problems = check(data);
  if (problems.length) {
    console.error(`Concept coverage check failed:\n- ${problems.join("\n- ")}`);
    return 1;
  }
  const text = render(data);
  if (args.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) {
      console.error("CONCEPT-COVERAGE.md is out of date. Run: npm run concepts");
      return 1;
    }
  } else {
    fs.writeFileSync(OUTPUT, text);
  }
  console.log(`Concept coverage OK: ${data.concepts.length} concepts.`);
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { check, render };
