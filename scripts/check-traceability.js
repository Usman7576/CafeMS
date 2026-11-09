// Usage: npm run trace            checks every link and rewrites docs/security/TRACEABILITY.md
//        npm run trace -- --check checks only, and fails if TRACEABILITY.md is out of date
// Every requirement must trace to a threat (or a regulation), to code that exists and to tests that
// exist; every threat must be covered by a requirement; every misuse case must point at both.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "docs", "security", "traceability.json");
const OUTPUT = path.join(ROOT, "docs", "security", "TRACEABILITY.md");
const STRIDE = ["Spoofing", "Tampering", "Repudiation", "Information Disclosure", "Denial of Service", "Elevation of Privilege"];
const TYPES = ["Functional", "Non-functional", "Regulatory"];

function testTitles() {
  const dir = path.join(ROOT, "tests");
  const titles = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".test.js"))) {
    for (const m of fs.readFileSync(path.join(dir, file), "utf8").matchAll(/(?:test|describe)\("((?:[^"\\]|\\.)+)"/g)) titles.set(m[1], file);
  }
  return titles;
}

function check(data, titles = testTitles()) {
  const problems = [];
  const ids = new Set();
  const unique = (id) => { if (ids.has(id)) problems.push(`${id} is used twice`); ids.add(id); };
  const threats = new Map(data.threats.map((t) => [t.id, t]));
  const requirements = new Map(data.requirements.map((r) => [r.id, r]));

  for (const t of data.threats) {
    unique(t.id);
    if (!STRIDE.includes(t.stride)) problems.push(`${t.id} has an unknown STRIDE category "${t.stride}"`);
    if (!data.requirements.some((r) => r.threats.includes(t.id))) problems.push(`${t.id} is not covered by any requirement`);
  }
  for (const r of data.requirements) {
    unique(r.id);
    if (!TYPES.includes(r.type)) problems.push(`${r.id} has an unknown type "${r.type}"`);
    if (!r.threats.length && !r.source) problems.push(`${r.id} traces to no threat or regulation`);
    for (const t of r.threats) if (!threats.has(t)) problems.push(`${r.id} names unknown threat ${t}`);
    if (r.type === "Regulatory" && !r.source) problems.push(`${r.id} is regulatory but names no regulation`);
    if (!r.code.length) problems.push(`${r.id} names no code`);
    for (const file of r.code) if (!fs.existsSync(path.join(ROOT, file))) problems.push(`${r.id}: ${file} does not exist`);
    if (!r.tests.length) problems.push(`${r.id} names no test`);
    for (const t of r.tests) if (!titles.has(t)) problems.push(`${r.id}: no test named "${t}"`);
  }
  for (const m of data.misuseCases) {
    unique(m.id);
    if (!requirements.has(m.requirement)) problems.push(`${m.id} names unknown requirement ${m.requirement}`);
    if (!m.tests.length) problems.push(`${m.id} names no test`);
    for (const t of m.tests) if (!titles.has(t)) problems.push(`${m.id}: no test named "${t}"`);
  }
  return problems;
}

const cell = (text) => String(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function render(data, titles = testTitles()) {
  const lines = [
    "# Traceability matrix",
    "",
    "Generated from `traceability.json` by `npm run trace`; do not edit by hand. A test fails if any link below is broken or this file is out of date.",
    "",
    `${data.requirements.length} requirements, ${data.threats.length} threats and ${data.misuseCases.length} misuse cases. Every requirement traces to a threat or regulation, to the code that meets it and to the tests that prove it.`,
    "",
    "## Requirements",
    "",
    "| ID | Type | Priority | Requirement | Threats or source | Code | Tests |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const r of data.requirements) {
    const traces = [...r.threats, ...(r.source ? [r.source] : [])].join(", ");
    const tests = r.tests.map((t) => `${t} (${titles.get(t)})`).join("; ");
    const text = r.note ? `${r.text} *${r.note}*` : r.text;
    lines.push(`| ${r.id} | ${r.type} | ${r.priority} | ${cell(text)} | ${cell(traces)} | ${r.code.map((c) => `\`${c}\``).join(", ")} | ${cell(tests)} |`);
  }
  lines.push("", "## Threats by STRIDE category", "", "| ID | STRIDE | Component | Threat | Likely attacker | Met by |", "| --- | --- | --- | --- | --- | --- |");
  for (const category of STRIDE) {
    for (const t of data.threats.filter((x) => x.stride === category)) {
      const by = data.requirements.filter((r) => r.threats.includes(t.id)).map((r) => r.id).join(", ");
      lines.push(`| ${t.id} | ${t.stride} | ${cell(t.component)} | ${cell(t.threat)} | ${cell(t.attacker)} | ${by} |`);
    }
  }
  lines.push("", "## Use and misuse cases", "", "| ID | Module | Use case | Misuse case | System response | Requirement | Tests |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const m of data.misuseCases) {
    lines.push(`| ${m.id} | ${cell(m.module)} | ${cell(m.useCase)} | ${cell(m.misuseCase)} | ${cell(m.response)} | ${m.requirement} | ${cell(m.tests.join("; "))} |`);
  }
  return `${lines.join("\n")}\n`;
}

function run(args) {
  const data = JSON.parse(fs.readFileSync(SOURCE, "utf8"));
  const titles = testTitles();
  const problems = check(data, titles);
  if (problems.length) {
    console.error(`Traceability check failed:\n- ${problems.join("\n- ")}`);
    return 1;
  }
  const text = render(data, titles);
  if (args.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) {
      console.error("TRACEABILITY.md is out of date. Run: npm run trace");
      return 1;
    }
  } else {
    fs.writeFileSync(OUTPUT, text);
  }
  console.log(`Traceability OK: ${data.requirements.length} requirements, ${data.threats.length} threats, ${data.misuseCases.length} misuse cases.`);
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = { check, render, testTitles };
