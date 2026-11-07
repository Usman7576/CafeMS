// Traceability (Week 4): every requirement must keep its threat, its code and its tests.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { check, render, testTitles } = require("../scripts/check-traceability");

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
    for (const m of text.matchAll(/\]\(([A-Za-z0-9_-]+\.md)(?:#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(path.join(DOCS, m[1])), `${file} links to missing ${m[1]}`);
    }
  }
});
