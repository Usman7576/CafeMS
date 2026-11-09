// Traceability (Week 4): every requirement must keep its threat, its code and its tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { check, render, testTitles } = require("../scripts/check-traceability");
const concepts = require("../scripts/check-concepts");

const DOCS = path.join(__dirname, "..", "docs", "security");
const data = JSON.parse(fs.readFileSync(path.join(DOCS, "traceability.json"), "utf8"));

test("every requirement traces to a threat or regulation, to code that exists and to tests that exist", () => {
  assert.deepEqual(check(data), []);
  for (const type of ["Functional", "Non-functional", "Regulatory"]) assert.ok(data.requirements.some((r) => r.type === type), type);
});

test("every STRIDE category has at least one threat, and every threat is met by a requirement", () => {
  for (const category of ["Spoofing", "Tampering", "Repudiation", "Information Disclosure", "Denial of Service", "Elevation of Privilege"]) {
    assert.ok(data.threats.some((t) => t.stride === category), category);
  }
});

test("a broken link is caught: a missing test, a missing file and an uncovered threat", () => {
  const broken = JSON.parse(JSON.stringify(data));
  broken.requirements[0].tests.push("a test that does not exist");
  broken.requirements[0].code.push("server/missing.js");
  broken.threats.push({ id: "T-99", stride: "Spoofing", component: "X", threat: "Y", attacker: "Z" });
  const problems = check(broken);
  assert.ok(problems.some((p) => p.includes("a test that does not exist")));
  assert.ok(problems.some((p) => p.includes("server/missing.js")));
  assert.ok(problems.some((p) => p.includes("T-99")));
});

test("TRACEABILITY.md is up to date with traceability.json", () => {
  const current = fs.readFileSync(path.join(DOCS, "TRACEABILITY.md"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(current, render(data, testTitles()), "Run: npm run trace");
});

test("links between the security documents point at files that exist", () => {
  for (const file of fs.readdirSync(DOCS).filter((f) => f.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(DOCS, file), "utf8");
    for (const m of text.matchAll(/\]\(([\w-]+\.md)[#)]/g)) {
      assert.ok(fs.existsSync(path.join(DOCS, m[1])), `${file} links to missing ${m[1]}`);
    }
  }
});

test("every lecture concept names files and tests that exist, and the coverage page is up to date", () => {
  const coverage = JSON.parse(fs.readFileSync(path.join(DOCS, "concept-coverage.json"), "utf8"));
  assert.deepEqual(concepts.check(coverage), []);
  assert.equal(fs.readFileSync(path.join(DOCS, "CONCEPT-COVERAGE.md"), "utf8").replace(/\r\n/g, "\n"), concepts.render(coverage), "Run: npm run concepts");
});

test("no placeholders remain in the project's documents", () => {
  const root = path.join(__dirname, "..");
  const files = ["README.md", "SECURITY.md", "SUBMISSION.md", "SUBMISSION-ACTIVITY2.md", "SUBMISSION-ACTIVITY3.md"];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /_\[[^\]]*(?:member|roll|url)[^\]]*\]_|add your public URL/i, file);
});
