// Activity 6: runs every evidence case (login and JWT, missing/modified tokens, role-based access,
// both modules' submit and retrieve, safe errors) and fails if any actual result differs from the
// expected one. The same cases write docs/activity-6/ when run with node scripts/activity6-evidence.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runCases } = require("../scripts/activity6-evidence");

test("every Activity 6 evidence case passes", async () => {
  const { results } = await runCases();
  assert.ok(results.length >= 30);
  const failed = results.filter((r) => !r.pass).map((r) => `${r.id} ${r.title}: ${JSON.stringify(r.actual)}`);
  assert.deepEqual(failed, []);
});
