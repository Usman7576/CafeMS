// The production setup must stay hardened: these tests read the real Dockerfile, compose file and
// workflows, and run the first-Admin command against a throwaway database.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { startDb, buildApp, browser, createUser, signIn, testEnv } = require("./helpers");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

// Splits the compose file into its services, by their two-space-indented names
function services(text) {
  const body = text.slice(text.indexOf("\nservices:\n"), text.search(/\nsecrets:\n/));
  const found = {};
  let current = null;
  for (const line of body.split("\n")) {
    const start = /^ {2}([a-z-]+):/.exec(line);
    if (start) current = start[1];
    if (current) found[current] = `${found[current] || ""}${line}\n`;
  }
  return found;
}

describe("container image", () => {
  const dockerfile = read("Dockerfile");

  test("runs on a pinned, minimal base as an unprivileged user", () => {
    for (const line of dockerfile.split("\n").filter((l) => l.startsWith("FROM "))) assert.match(line, /@sha256:[0-9a-f]{64}/, line);
    assert.match(dockerfile, /FROM gcr\.io\/distroless\/nodejs24-debian13:nonroot@/);
    assert.match(dockerfile, /^USER 65532:65532$/m);
    assert.match(dockerfile, /^HEALTHCHECK /m);
  });

  test("installs locked production packages only and copies no secrets, tests or git history", () => {
    assert.match(dockerfile, /npm ci --omit=dev/);
    for (const copied of dockerfile.split("\n").filter((l) => l.startsWith("COPY "))) assert.doesNotMatch(copied, /\.env|keyfile|tests|\.git/, copied);
    const ignored = read(".dockerignore").split("\n");
    for (const entry of [".env", ".mongo-keyfile", "deploy/.env", ".git", "tests", "backups"]) assert.ok(ignored.includes(entry), entry);
  });
});

describe("production stack", () => {
  const compose = read("deploy/docker-compose.yml");
  const all = services(compose);

  test("every service is read-only, drops all capabilities and cannot gain privileges", () => {
    assert.match(compose, /x-hardening: &hardening\n {2}read_only: true\n {2}cap_drop: \[ALL\]\n {2}security_opt: \["no-new-privileges:true"\]/);
    assert.deepEqual(Object.keys(all).sort(), ["app", "app-staff", "backup", "caddy", "db-init", "mongo", "restore"]);
    for (const [name, text] of Object.entries(all)) assert.match(text, /<<: \*(?:hardening|backup-tool|app-service)/, name);
  });

  test("only Caddy is reachable from outside, and the database network has no route out", () => {
    for (const [name, text] of Object.entries(all)) {
      if (name === "caddy") assert.match(text, /\n {4}ports:\n/);
      else assert.doesNotMatch(text, /\n {4}ports:/, name);
    }
    assert.match(compose, /backend:\n {4}internal: true/);
    assert.match(all.mongo, /networks: \[backend\]/);
    assert.match(all.caddy, /networks: \[frontend\]/);
  });

  test("the app never receives the database administrator password or the backup key", () => {
    assert.doesNotMatch(all.app, /MONGO_ROOT|MONGO_INITDB|BACKUP_KEY/);
    assert.match(all.app, /TRUST_PROXY: \$\{TRUST_PROXY:-1\}/);
    assert.match(all.app, /NODE_ENV: production/);
    assert.match(all.mongo, /--auth --keyFile/);
  });

  test("every database file is encrypted at rest with AES-256, and the key stays out of git and the image", () => {
    for (const text of [all.mongo, read("deploy/docker-compose.ha.yml")]) {
      assert.match(text, /--enableEncryption --encryptionKeyFile \/tmp\/encryption-key --encryptionCipherMode AES256-GCM/);
      assert.match(text, /percona-server-mongodb/);
    }
    assert.match(read("scripts/setup-env.js"), /randomBytes\(32\)/);
    for (const file of [".gitignore", ".dockerignore"]) assert.ok(read(file).includes("deploy/.mongo-encryption-key"), file);
  });

  test("third-party images are pinned by digest, and Caddy's admin interface is off", () => {
    assert.match(all.mongo, /image: [a-z0-9:./-]+@sha256:[0-9a-f]{64}/);
    // Caddy is built from pinned base images and pinned modules
    const caddyBuild = read("deploy/caddy.Dockerfile");
    for (const line of caddyBuild.split("\n").filter((l) => l.startsWith("FROM "))) assert.match(line, /@sha256:[0-9a-f]{64}/, line);
    assert.match(caddyBuild, /coraza-caddy\/v2@v\d+\.\d+\.\d+/);
    assert.match(caddyBuild, /caddy-ratelimit@[0-9a-f]{12}/);
    assert.match(caddyBuild, /^USER 1000:1000$/m, "Caddy runs as a non-root user");
    assert.match(read("deploy/Caddyfile"), /admin off/);
  });

  test("generated secrets stay out of git", () => {
    const ignored = read(".gitignore").split("\n");
    for (const entry of [".env", ".mongo-keyfile", "deploy/.env", "deploy/.mongo-keyfile", "backups/", "uploads/"]) assert.ok(ignored.includes(entry), entry);
  });
});

describe("pipeline", () => {
  const dir = ".github/workflows";
  const files = fs.readdirSync(path.join(root, dir));

  test("every action is pinned to a commit, and the default token is read-only", () => {
    for (const file of files) {
      const text = read(`${dir}/${file}`);
      for (const m of text.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${file}: ${m[1]}`);
      assert.match(text, /^permissions:\n {2}contents: read$/m, file);
    }
  });

  test("CI runs every tool the plan names", () => {
    const ci = read(`${dir}/ci.yml`);
    for (const tool of ["npm run lint", "npm run test:coverage", "npm audit", "semgrep", "codeql-action", "gitleaks", "aquasec/trivy", "zap-baseline.py", "zap-api-scan.py", "attack-replay.js", "Recovery drill", "Failover drill", "npm run trace", "npm run concepts"]) {
      assert.ok(ci.includes(tool), tool);
    }
  });
});

describe("web application firewall", () => {
  test("Caddy runs the OWASP Core Rule Set in blocking mode and limits requests per address", () => {
    const caddy = read("deploy/Caddyfile");
    assert.match(caddy, /order coraza_waf first/);
    assert.match(caddy, /load_owasp_crs/);
    assert.match(caddy, /Include @owasp_crs\/\*\.conf/);
    assert.match(caddy, /SecRuleEngine On/);
    assert.match(caddy, /rate_limit \{/);
    assert.match(read("deploy/docker-compose.yml"), /dockerfile: caddy\.Dockerfile/);
  });
});

describe("redundancy and signed releases", () => {
  test("staff sessions and public traffic are served by separate app processes", () => {
    const caddy = read("deploy/Caddyfile");
    assert.match(caddy, /@staff header Cookie \*__Host-cms_session=\*/);
    assert.match(caddy, /reverse_proxy app-staff:3000/);
    assert.match(caddy, /reverse_proxy app:3000/);
    const compose = read("deploy/docker-compose.yml");
    assert.match(compose, /app-staff:\s+<<: \*app-service/);
    assert.match(compose, /RUN_WORKERS: "false"/);
    assert.match(read("server/index.js"), /config\.runWorkers \? startWorkers/);
    assert.match(read("deploy/docker-compose.ha.yml"), /app-staff:\s+environment:\s+MONGODB_URI: \*uri/);
  });

  test("the three-member database option has three members, and the app can reach them all", () => {
    const ha = read("deploy/docker-compose.ha.yml");
    for (const member of ["mongo:27017", "mongo2:27017", "mongo3:27017"]) assert.ok(ha.includes(`host: '${member}'`), member);
    assert.match(ha, /x-uri: &uri mongodb:\/\/[^\n]*@mongo:27017,mongo2:27017,mongo3:27017\//);
    assert.match(ha, /read_only: true\n {2}cap_drop: \[ALL\]/);
  });

  test("releases carry a signed provenance attestation and checksums", () => {
    const release = read(".github/workflows/release.yml");
    assert.match(release, /attest-build-provenance@[0-9a-f]{40}/);
    assert.match(release, /id-token: write/);
    assert.match(release, /sha256sum/);
  });
});

describe("first Admin of a new deployment", () => {
  let ctx;
  const run = (...args) => spawnSync(process.execPath, ["scripts/create-admin.js", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, ...env }
  });
  let env;
  before(async () => {
    ctx = await startDb();
    env = testEnv({ MONGODB_URI: ctx.uri, MONGODB_DB: "cafems_test" });
  });
  after(() => ctx.stop());

  test("creates an invitation, storing only the hash of its link, and is audited", async () => {
    const result = run("owner", "Cafe Owner");
    assert.equal(result.status, 0, result.stderr);
    const token = /#token=([\w-]+)/.exec(result.stdout)[1];
    const user = await ctx.db.collection("users").findOne({ username: "owner" });
    assert.equal(user.role, "Admin");
    assert.equal(user.status, "Invited");
    assert.equal(user.passwordHash, undefined);
    assert.equal(await ctx.db.collection("auth_tokens").countDocuments({ _id: token }), 0);
    assert.equal(await ctx.db.collection("auth_tokens").countDocuments({ username: "owner" }), 1);
    assert.ok(await ctx.db.collection("audit_events").findOne({ action: "Admin invited from the server", severity: "high" }));
  });

  test("allows a second Admin, then refuses, so it cannot get round the second-Admin rule", async () => {
    assert.equal(run("second", "Second Admin").status, 0);
    const result = run("third", "Third Admin");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Two Admins already exist/);
    assert.equal(await ctx.db.collection("users").countDocuments({ username: "third" }), 0);
  });

  test("the server's operator can recover a locked-out Admin, replacing their credentials", async () => {
    await ctx.db.collection("users").updateOne({ username: "owner" }, { $set: { status: "Disabled", passwordHash: "old", "mfa.enabled": true } });
    const result = run("--recover", "owner");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /#token=/);
    const user = await ctx.db.collection("users").findOne({ username: "owner" });
    assert.equal(user.status, "Invited");
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.mfa.enabled, false);
    assert.ok(await ctx.db.collection("audit_events").findOne({ action: "Admin recovered from the server", details: "owner", severity: "high" }));
    assert.equal(run("--recover", "nobody.here").status, 1);
  });

  test("refuses a bad username", () => {
    assert.equal(run("Bad Name!", "Someone").status, 1);
  });
});

describe("public website under load", () => {
  let ctx, db;
  before(async () => {
    ctx = await startDb();
    db = ctx.db;
  });
  after(() => ctx.stop());

  test("repeat requests come from the short cache, and a staff change clears it at once", async () => {
    const { app, config } = buildApp(db);
    assert.equal((await browser(app).get("/api/v1/public/info")).body.name, "CafeMS");
    await db.collection("settings").updateOne({ _id: "cafe" }, { $set: { name: "Changed Directly" } }, { upsert: true });
    assert.equal((await browser(app).get("/api/v1/public/info")).body.name, "CafeMS");
    const admin = await signIn(app, db, await createUser(db, config, { role: "Admin" }));
    await admin.put("/api/v1/settings/cafe", { name: "Saved By Admin", tagline: "", about: "", address: "", phone: "", hours: "" });
    assert.equal((await browser(app).get("/api/v1/public/info")).body.name, "Saved By Admin");
  });

  test("one address can read the public API only a limited number of times", async () => {
    const { app } = buildApp(db, { publicReadsPerMinute: 2 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await browser(app).get("/api/v1/public/menu")).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  });
});
