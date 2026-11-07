const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { startDb, buildApp, browser, createUser, signIn, testConfig } = require("./helpers");
const { createApp } = require("../server/app");
const { createLogger } = require("../server/lib/logger");
const { PAGES, HOME } = require("../server/lib/permissions");

let ctx, db, app, config;
before(async () => {
  ctx = await startDb();
  db = ctx.db;
  ({ app, config } = buildApp(db));
});
after(() => ctx.stop());

describe("removed and hidden paths", () => {
  test("the old whole-database routes are gone (findings 2, 3)", async () => {
    assert.equal((await request(app).get("/api/state")).status, 404);
    assert.equal((await request(app).put("/api/state").send({ state: {} })).status, 404);
  });

  test("project files cannot be downloaded (finding 15)", async () => {
    const paths = ["/.env", "/.env.example", "/.git/config", "/package.json", "/package-lock.json", "/server.js", "/server/index.js", "/server/config.js",
      "/README.md", "/tests/helpers.js", "/js/..%2f..%2fpackage.json", "/public/index.html", "/node_modules/express/package.json", "/js/.hidden"];
    for (const path of paths) assert.equal((await request(app).get(path)).status, 404, path);
  });

  test("the public health checks reveal status only (finding 18)", async () => {
    for (const path of ["/api/health", "/api/health/live", "/api/health/ready"]) assert.deepEqual((await request(app).get(path)).body, { ok: true });
  });
});

describe("page guard", () => {
  test("every protected page redirects a visitor to sign in", async () => {
    for (const page of Object.keys(PAGES)) {
      const res = await request(app).get(page);
      assert.equal(res.status, 302, page);
      assert.equal(res.headers.location, "/login.html");
    }
  });

  test("tricks to dodge the guard do not reveal a page", async () => {
    for (const path of ["/USERS.HTML", "/users.html.", "/users.html%20", "/./users.html%00", "//users.html", "/users.html/", "/js/../users.html", "/users"]) {
      const res = await request(app).get(path);
      assert.ok([302, 404].includes(res.status), `${path} gave ${res.status}`);
      assert.ok(!res.text || !res.text.includes("Staff &amp; roles"), path);
    }
  });

  test("each role can open only its own pages", async () => {
    for (const role of Object.keys(HOME)) {
      const client = await signIn(app, db, await createUser(db, config, { role }));
      for (const [page, roles] of Object.entries(PAGES)) {
        const res = await client.get(page);
        if (roles.includes(role)) {
          assert.equal(res.status, 200, `${role} ${page}`);
          assert.match(res.headers["cache-control"], /no-store/);
        } else {
          assert.equal(res.status, 302, `${role} ${page}`);
          assert.equal(res.headers.location, HOME[role]);
        }
      }
    }
  });

  test("a denied page is recorded", async () => {
    const user = await createUser(db, config);
    const client = await signIn(app, db, user);
    await client.get("/audit.html");
    const event = await db.collection("audit_events").findOne({ actor: user.username, action: "Access denied" });
    assert.match(event.details, /audit\.html/);
  });

  test("public pages and assets load without signing in", async () => {
    for (const path of ["/", "/index.html", "/login.html", "/setup.html", "/privacy.html", "/css/style.css", "/js/login.js", "/assets/favicon.svg", "/assets/bean.svg", "/vendor/three.module.min.js", "/js/coffee-scene.js"]) {
      assert.equal((await request(app).get(path)).status, 200, path);
    }
  });

  test("demo accounts and the any-password rule are gone from the public pages", async () => {
    for (const path of ["/", "/login.html"]) {
      const text = (await request(app).get(path)).text.toLowerCase();
      assert.ok(!text.includes("demo account"), path);
      assert.ok(!text.includes("any password"), path);
    }
  });
});

describe("security headers (finding 13)", () => {
  test("are present on pages and API responses", async () => {
    for (const path of ["/login.html", "/api/v1/auth/me"]) {
      const { headers } = await request(app).get(path);
      assert.equal(headers["x-content-type-options"], "nosniff");
      assert.equal(headers["referrer-policy"], "no-referrer");
      assert.equal(headers["x-powered-by"], undefined);
      assert.ok(headers["permissions-policy"]);
      assert.ok(headers["x-request-id"]);
      const csp = headers["content-security-policy"];
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
    }
  });

  test("no page has inline scripts or inline event handlers", async () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "public");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      const html = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${file} has an inline script`);
      assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(html), `${file} has an inline handler`);
    }
  });

  test("the CSP has no exceptions: no inline styles, no third-party hosts, Trusted Types required", async () => {
    const csp = (await request(app).get("/login.html")).headers["content-security-policy"];
    assert.ok(!csp.includes("unsafe-inline"));
    assert.ok(!csp.includes("unsafe-eval"));
    assert.ok(!csp.includes("https:"));
    assert.match(csp, /style-src 'self'(;|$)/);
    assert.match(csp, /font-src 'self'(;|$)/);
    assert.match(csp, /require-trusted-types-for 'script'/);
  });

  test("no page uses inline styles or third-party resources (findings 21, 22)", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "public");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      const html = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!/\sstyle=/i.test(html), `${file} has an inline style`);
      assert.ok(!/(?:src|href)="https?:/i.test(html), `${file} loads a third-party resource`);
    }
  });

  test("no browser script writes HTML from strings or stores business data on the device (findings 14, 20, 30)", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "public", "js");
    for (const file of fs.readdirSync(dir)) {
      const code = fs.readFileSync(path.join(dir, file), "utf8");
      for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
        assert.ok(!code.includes(sink), `${file} uses ${sink}`);
      }
      // common.js only deletes the old prototype's stored data; nothing is stored or read back
      assert.ok(!/localStorage\.(?:setItem|getItem)/.test(code), `${file} stores data on the device`);
      assert.ok(!/addEventListener\(["']storage["']/.test(code), `${file} reacts to stored data from other tabs`);
    }
  });

  test("fonts load from this server (finding 21)", async () => {
    assert.equal((await request(app).get("/fonts/inter-latin-400-normal.woff2")).status, 200);
    assert.equal((await request(app).get("/css/fonts.css")).status, 200);
  });

  test("API responses are never cached", async () => {
    assert.match((await request(app).get("/api/v1/auth/me")).headers["cache-control"], /no-store/);
  });

  test("HSTS is sent when the site uses TLS", async () => {
    const tls = { ...testConfig(), usesTls: true };
    const res = await request(createApp({ config: tls, db, logger: createLogger(tls) })).get("/login.html");
    assert.match(res.headers["strict-transport-security"], /max-age=31536000/);
  });
});

describe("limits and errors", () => {
  test("oversized bodies are refused", async () => {
    const res = await browser(app).post("/api/v1/auth/login", { username: "a".repeat(150 * 1024), password: "x" });
    assert.equal(res.status, 413);
  });

  test("broken JSON gives a clean error with no stack trace", async () => {
    const res = await request(app).post("/api/v1/auth/login").set("Origin", "http://localhost:3000").set("Content-Type", "application/json").send("{bad json");
    assert.equal(res.status, 400);
    assert.ok(!res.text.includes("SyntaxError"));
    assert.ok(!res.text.includes("node_modules"));
  });

  test("the general API rate limit applies", async () => {
    const limited = buildApp(db, { apiPerMinute: 2 }).app;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(limited).get("/api/v1/auth/me")).status);
    assert.deepEqual(statuses, [401, 401, 429]);
  });

  test("audit text cannot forge extra log lines", async () => {
    const name = "evil\nFake entry";
    await browser(app).post("/api/v1/auth/login", { username: name, password: "Wrong-Password-99!" });
    const event = await db.collection("audit_events").findOne({ actor: /^evil/ });
    assert.ok(!event.actor.includes("\n"));
  });
});

describe("fail-secure when the database is down", () => {
  const SECRET = "mongodb://root:hunter2@internal-host";
  const brokenDb = { collection: () => new Proxy({}, { get: () => async () => { throw new Error(`connection failed ${SECRET}`); } }), command: async () => { throw new Error(SECRET); } };
  const broken = () => createApp({ config, db: brokenDb, logger: createLogger(config) });

  test("sign-in fails closed and reveals nothing", async () => {
    const res = await browser(broken()).post("/api/v1/auth/login", { username: "someone", password: "Wrong-Password-99!" });
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes("hunter2"));
    assert.ok(res.body.error.requestId);
  });

  test("protected pages are not served", async () => {
    const client = browser(broken());
    client.jar["__Host-cms_session"] = (await signIn(app, db, await createUser(db, config, { role: "Admin" }))).jar["__Host-cms_session"];
    const res = await client.get("/users.html");
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes("<html"));
    assert.ok(!res.text.includes("hunter2"));
  });

  test("health reports 503 without details", async () => {
    const res = await request(broken()).get("/api/health/ready");
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false });
    assert.equal((await request(broken()).get("/api/health/live")).status, 200);
  });
});

test("every route has a guard, so none can be left open by accident (complete mediation)", () => {
  const found = [];
  function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        const guards = layer.route.stack.map((s) => s.handle.guard).filter(Boolean);
        found.push({ path: `${prefix}${layer.route.path}`, method: Object.keys(layer.route.methods)[0], guards });
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  }
  walk(app._router.stack, "");
  assert.ok(found.length >= 15, `only found ${found.length} routes`);
  const unguarded = found.filter((r) => !r.guards.length).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(unguarded, []);

  // Public routes are an explicit, reviewed list
  const open = found.filter((r) => r.guards.includes("public")).map((r) => r.path).sort();
  assert.deepEqual(open.map(String), ["/api/health,/api/health/ready", "/api/health/live", "/info", "/login", "/menu", "/menu/:id/photo", "/mfa/enroll/confirm", "/mfa/enroll/start", "/mfa/verify", "/payments/callback", "/reservations", "/setup"].sort());
});
