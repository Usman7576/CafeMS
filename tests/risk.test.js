// The course's risk methods as code. Each worked example from the slides is reproduced exactly.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { wses, wsesRange, rpn, rank, RiskInputError } = require("../server/lib/risk");
const deps = require("../server/lib/dependencies");
const { startDb, buildApp, createUser, signIn } = require("./helpers");

describe("Weighted Security Exposure Score (WSES deck)", () => {
  test("reproduces the slides: login portal 40, order API 24, inventory 8", () => {
    assert.equal(wses({ accessibility: "High", dataSensitivity: "High", pastIncidents: "High", complexity: "High" }), 40);
    assert.equal(wses({ accessibility: "Medium", dataSensitivity: "Medium", pastIncidents: "Medium", complexity: "Medium" }), 24);
    assert.equal(wses({ accessibility: "Low", dataSensitivity: "Low", pastIncidents: "Low", complexity: "Low" }), 8);
  });

  test("ranks the slides' components in the same order", () => {
    const ranked = rank([
      { name: "Inventory Management System", r: { accessibility: 1, dataSensitivity: 1, pastIncidents: 1, complexity: 1 } },
      { name: "Customer Login Portal", r: { accessibility: 5, dataSensitivity: 5, pastIncidents: 5, complexity: 5 } },
      { name: "Order Processing API", r: { accessibility: 3, dataSensitivity: 3, pastIncidents: 3, complexity: 3 } }
    ], (c) => wses(c.r));
    assert.deepEqual(ranked.map((c) => [c.rank, c.name, c.score]), [[1, "Customer Login Portal", 40], [2, "Order Processing API", 24], [3, "Inventory Management System", 8]]);
  });

  test("works with other weights and scales, as in the telemedicine exercise (4/5/3/2 and 1/5/8)", () => {
    const options = { weights: { accessibility: 4, dataSensitivity: 5, pastIncidents: 3, complexity: 2 }, levels: { Low: 1, Medium: 5, High: 8 } };
    // Patient Portal: public, highly sensitive, multiple incidents, complex
    assert.equal(wses({ accessibility: "High", dataSensitivity: "High", pastIncidents: "High", complexity: "High" }, options), 112);
    // Public Health Resources Page: public, non-sensitive, no incidents, simple
    assert.equal(wses({ accessibility: "High", dataSensitivity: "Low", pastIncidents: "Low", complexity: "Low" }, options), 42);
    assert.deepEqual(wsesRange(), { min: 8, max: 40 });
  });

  test("refuses ratings it cannot score", () => {
    assert.throws(() => wses({ accessibility: "Extreme", dataSensitivity: "Low", pastIncidents: "Low", complexity: "Low" }), RiskInputError);
    assert.throws(() => wses({ accessibility: "Low", dataSensitivity: -1, pastIncidents: "Low", complexity: "Low" }), RiskInputError);
  });
});

describe("FMEA Risk Priority Number (FMEA deck)", () => {
  test("reproduces the slides: 648, 288 and 72, ranked in that order", () => {
    const ranked = rank([
      { failure: "Duplicate complaint submission", s: { severity: 4, occurrence: 9, detection: 2 } },
      { failure: "Unauthorized complaint access", s: { severity: 9, occurrence: 8, detection: 9 } },
      { failure: "Lost complaint notifications", s: { severity: 6, occurrence: 6, detection: 8 } }
    ], (f) => rpn(f.s));
    assert.deepEqual(ranked.map((f) => [f.rank, f.failure, f.score]), [
      [1, "Unauthorized complaint access", 648], [2, "Lost complaint notifications", 288], [3, "Duplicate complaint submission", 72]
    ]);
  });

  test("recalculates after the corrective action: 648 falls to 54 while severity stays 9", () => {
    assert.equal(rpn({ severity: 9, occurrence: 2, detection: 3 }), 54);
  });

  test("ratings must be whole numbers from 1 to 10", () => {
    for (const bad of [0, 11, 2.5, "9", null]) assert.throws(() => rpn({ severity: bad, occurrence: 5, detection: 5 }), RiskInputError);
  });
});

describe("dependency matrix (Dependency Matrix and Failures decks)", () => {
  const shopMini = {
    components: ["APP", "AUTH", "CAT", "ORD", "MAIL", "PAY"],
    external: ["PAY"],
    matrix: [
      ["0", "2", "2", "2", "0", "0"],
      ["0", "0", "0", "0", "0", "0"],
      ["0", "0", "0", "0", "0", "0"],
      ["0", "2", "0", "0", "1A", "1"],
      ["0", "0", "0", "0", "0", "0"],
      ["0", "0", "0", "0", "0", "0"]
    ]
  };

  test("reproduces ShopMini's degrees: AUTH in 2 out 0, ORD in 1 out 3, PAY in 1 out 0", () => {
    const d = Object.fromEntries(deps.degrees(shopMini).map((x) => [x.component, [x.inDegree, x.outDegree]]));
    assert.deepEqual(d.AUTH, [2, 0]);
    assert.deepEqual(d.ORD, [1, 3]);
    assert.deepEqual(d.PAY, [1, 0]);
  });

  test("a soft payment failure leaves orders working; a hard login failure stops them", () => {
    assert.deepEqual(deps.failureImpact(shopMini, "PAY"), { failed: "PAY", stopped: [], degraded: ["ORD"], delayed: [] });
    assert.deepEqual(deps.failureImpact(shopMini, "MAIL"), { failed: "MAIL", stopped: [], degraded: [], delayed: ["ORD"] });
    assert.deepEqual(deps.failureImpact(shopMini, "AUTH").stopped.sort(), ["APP", "ORD"]);
  });

  test("a failure spreads along hard dependencies: the database takes down the web server, inventory and front end", () => {
    // The Failures deck's e-commerce example: F -> W, W -> D, P, I, and I -> D
    const shop = {
      components: ["F", "W", "D", "P", "I"],
      matrix: [["0", "2", "0", "0", "0"], ["0", "0", "2", "2", "2"], ["0", "0", "0", "0", "0"], ["0", "0", "0", "0", "0"], ["0", "0", "2", "0", "0"]]
    };
    assert.deepEqual(deps.failureImpact(shop, "D").stopped.sort(), ["F", "I", "W"]);
    assert.equal(deps.singlePointsOfFailure(shop)[0].component, "D");
  });

  test("refuses codes the course does not define, and self-dependencies", () => {
    const bad = (cell) => ({ components: ["A", "B"], matrix: [["0", cell], ["0", "0"]] });
    assert.throws(() => deps.validate(bad("3")), deps.MatrixError);
    assert.throws(() => deps.validate(bad("1B")), deps.MatrixError);
    assert.throws(() => deps.validate({ components: ["A"], matrix: [["2"]] }), deps.MatrixError);
  });

  test("CafeMS's own matrix is valid and names the database as its main single point of failure", () => {
    const model = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "security", "dependency-matrix.json"), "utf8"));
    const spof = deps.singlePointsOfFailure(model);
    assert.equal(spof[0].component, "DB");
    assert.deepEqual(deps.failureImpact(model, "PAY"), { failed: "PAY", stopped: [], degraded: ["API"], delayed: [] });
    // An action that cannot be audited does not happen, so the audit log is a hard dependency
    assert.ok(deps.failureImpact(model, "AUDIT").stopped.includes("API"));
  });
});

describe("CafeMS risk register", () => {
  const register = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "security", "risk-register.json"), "utf8"));
  const titles = new Set();
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))) {
    for (const m of fs.readFileSync(path.join(__dirname, file), "utf8").matchAll(/(?:test|describe)\("((?:[^"\\]|\\.)+)"/g)) titles.add(m[1]);
  }

  test("every rating is valid, and every failure mode is lower now than before", () => {
    for (const c of register.components) {
      wses(c.before);
      if (c.after) wses(c.after);
    }
    for (const f of register.failureModes) assert.ok(rpn(f.after) < rpn(f.before), f.id);
  });

  test("the starting scores match the plan's audit: login 38, billing 36, inventory 12", () => {
    const score = (id) => wses(register.components.find((c) => c.id === id).before);
    assert.equal(score("auth"), 38);
    assert.equal(score("billing"), 36);
    assert.equal(score("inventory"), 12);
  });

  test("every control it claims is proved by a test that exists", () => {
    for (const f of register.failureModes) {
      assert.ok(f.tests.length > 0, f.id);
      for (const t of f.tests) assert.ok(titles.has(t), `${f.id}: no test named "${t}"`);
    }
  });
});

describe("Admin risk page", () => {
  let ctx, db, app, config;
  before(async () => {
    ctx = await startDb();
    db = ctx.db;
    ({ app, config } = buildApp(db));
  });
  after(() => ctx.stop());

  test("shows scores worked out by the server, and the export is recorded", async () => {
    const admin = await signIn(app, db, await createUser(db, config, { role: "Admin" }));
    const data = (await admin.get("/api/v1/risk")).body;
    const auth = data.components.find((c) => c.id === "auth");
    assert.equal(auth.before.score, 38);
    assert.equal(data.components[0].rank, 1);
    assert.equal(data.failureModes.find((f) => f.id === "FM-3").after.rpn, 54);
    assert.equal(data.dependencies.singlePointsOfFailure[0].component, "DB");
    const csv = await admin.get("/api/v1/risk.csv");
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Failure mode \(RPN\),FM-1/);
    assert.ok(await db.collection("audit_events").findOne({ action: "Report exported", details: /Risk register/ }));
  });

  test("only an Admin can open it", async () => {
    const manager = await signIn(app, db, await createUser(db, config, { role: "Manager" }));
    assert.equal((await manager.get("/api/v1/risk")).status, 403);
    assert.equal((await manager.get("/risk.html")).status, 302);
  });
});
