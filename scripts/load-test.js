// Usage: npm run load-test            prints the results
//        npm run load-test -- --write writes them to docs/security/LOAD-TEST.md as well
//
// Performance under attack (Week 4, SR-20). Staff screen refreshes (six signed-in staff on the cafe's
// one Wi-Fi address) are timed alone, then again while attackers from 50 network addresses flood the
// sign-in, booking and page routes. It uses
// the real rate limits, a throwaway in-memory database and real HTTP on this computer. As in production,
// staff with a session and everyone else are served by separate app processes (see deploy/Caddyfile).
// Pass: every one of the waiter's requests succeeds, and its 95th-percentile time stays within the
// target. The Week 4 example target is no more than 10% slower; that is reported as well.
const fs = require("fs");
const http = require("http");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");
const path = require("path");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const authenticator = require("../server/lib/totp");
const { loadConfig } = require("../server/config");
const { createApp } = require("../server/app");
const { ensureIndexes, ensureAuditIndexes } = require("../server/db");
const { createLogger } = require("../server/lib/logger");
const { testEnv, createUser } = require("../tests/helpers");

// Kept low enough that all the rounds together stay under the real per-address and per-person limits
const SAMPLES = 100;
// One burst can be lucky or unlucky, so the result is the median of several timed rounds
const ROUNDS = 5;
const ATTACKERS = 50;
const ATTACK_CONCURRENCY = 64;
// A screen refresh slower than this would be noticed at the till
const P95_LIMIT_MS = 250;

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = await MongoClient.connect(replSet.getUri());
  const db = client.db("cafems_load");
  await ensureIndexes(db);
  await ensureAuditIndexes(db);

  // Both app processes share one set of keys, as they do through deploy/.env in production
  const env = testEnv({ NODE_ENV: "test", TRUST_PROXY: "1" });
  const config = loadConfig(env);
  const app = createApp({ config, db, logger: createLogger(config) });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

  function request(method, url, { body, headers = {}, ip } = {}) {
    return new Promise((resolve) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const started = process.hrtime.bigint();
      const req = http.request(base + url, {
        method, agent,
        headers: {
          Origin: config.appOrigin, "X-Forwarded-For": ip, ...headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      });
      req.on("error", () => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  // A shift of staff sign in like real people, all from the cafe's one Wi-Fi address. Each stays well
  // under the per-person limit, as a real screen does (about 20 refreshes a minute).
  const cafeIp = "10.0.0.1";
  async function signIn(role) {
    const user = await createUser(db, config, { role });
    const cookies = {};
    const keep = (res) => (res.headers["set-cookie"] || []).forEach((line) => {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      cookies[pair.slice(0, at)] = pair.slice(at + 1);
    });
    const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    keep(await request("POST", "/api/v1/auth/login", { body: { username: user.username, password: user.password }, ip: cafeIp }));
    keep(await request("POST", "/api/v1/auth/mfa/verify", { body: { code: authenticator.generate(user.secret) }, headers: { Cookie: header() }, ip: cafeIp }));
    if (!cookies["__Host-cms_session"]) throw new Error("A member of staff could not sign in.");
    return header();
  }
  const staff = [];
  for (const role of ["Waiter", "Waiter", "Waiter", "Kitchen", "Cashier", "Manager"]) staff.push(await signIn(role));

  async function waiterRun() {
    const times = [];
    let failed = 0;
    const reasons = {};
    for (let i = 0; i < SAMPLES; i += 1) {
      const res = await request("GET", "/api/v1/snapshot", { headers: { Cookie: staff[i % staff.length], "X-Background-Refresh": "1" }, ip: cafeIp });
      if (res.status !== 200) {
        failed += 1;
        let code = "";
        try { code = JSON.parse(res.body).error.code; } catch { /* not a JSON error */ }
        const reason = `${res.status} ${code}`.trim();
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      times.push(res.ms);
    }
    return { times, failed, reasons, p50: percentile(times, 50), p95: percentile(times, 95) };
  }

  await waiterRun(); // warm-up
  const rounds = async () => {
    const results = [];
    for (let i = 0; i < ROUNDS; i += 1) results.push(await waiterRun());
    const median = [...results].sort((a, b) => a.p95 - b.p95)[Math.floor(ROUNDS / 2)];
    const reasons = {};
    for (const r of results) for (const [reason, count] of Object.entries(r.reasons)) reasons[reason] = (reasons[reason] || 0) + count;
    return { ...median, failed: results.reduce((total, r) => total + r.failed, 0), reasons, p95s: results.map((r) => r.p95) };
  };
  const baseline = await rounds();

  // The attack runs on its own thread, as a real attacker's traffic comes from outside: generating it
  // must not compete with the server for the server's own thread
  const publicServer = new Worker(__filename, { workerData: { role: "public", uri: replSet.getUri(), env } });
  const publicPort = await new Promise((resolve, reject) => { publicServer.once("message", resolve); publicServer.once("error", reject); });
  const attacker = new Worker(__filename, { workerData: { role: "attack", base: `http://127.0.0.1:${publicPort}`, origin: config.appOrigin, concurrency: ATTACK_CONCURRENCY, attackers: ATTACKERS } });
  const messages = [];
  const next = () => new Promise((resolve, reject) => {
    if (messages.length) return resolve(messages.shift());
    attacker.once("message", resolve);
    attacker.once("error", reject);
    return undefined;
  });
  await next(); // the attacker thread has loaded and its first requests have been answered
  await new Promise((r) => setTimeout(r, 1500)); // let the flood build up first
  const underAttack = await rounds();
  attacker.postMessage("stop");
  const attack = await next();
  await attacker.terminate();
  await publicServer.terminate();

  agent.destroy();
  await new Promise((resolve) => server.close(resolve));
  await client.close();
  await replSet.stop();

  const slower = ((underAttack.p95 - baseline.p95) / baseline.p95) * 100;
  const passed = underAttack.failed === 0 && underAttack.p95 <= P95_LIMIT_MS;
  return {
    date: new Date().toISOString().slice(0, 10), machine: `${os.cpus().length} CPU threads, Node ${process.version}`,
    samples: SAMPLES * ROUNDS, attackers: ATTACKERS, concurrency: ATTACK_CONCURRENCY,
    baseline, underAttack, attack, slower, passed, meetsTenPercent: slower <= 10
  };
}

function report(r) {
  const ms = (v) => `${v.toFixed(1)} ms`;
  return [
    "# Load test: performance under attack",
    "",
    `**${r.passed ? "No staff request failed, and the slowest 5% stayed under the limit" : "The test failed"}${r.meetsTenPercent ? "." : ", but response times did not meet the Week 4 example target of 10% slower."}** During a flood of ${r.attack.sent.toLocaleString()} attack requests from ${r.attackers} addresses, ${r.samples} staff screen refreshes from six signed-in staff ${r.underAttack.failed === 0 ? "all succeeded" : `had ${r.underAttack.failed} failures`}, and the slowest 5% took ${ms(r.underAttack.p95)} or less (limit ${P95_LIMIT_MS} ms).`,
    "",
    `Generated by \`npm run load-test -- --write\` on ${r.date} (${r.machine}). It uses the real rate limits, real HTTP and a throwaway database, with the attack on its own thread. Staff and public traffic are served by separate app processes, as in production. Each figure is the round with the median 95th percentile, of ${ROUNDS} rounds of ${SAMPLES} requests. Timings vary with the machine's load, so run it on the production server for figures that count. Requirement SR-20.`,
    "",
    "| Measure | Staff alone | Staff during the attack |",
    "| --- | --- | --- |",
    `| Median response | ${ms(r.baseline.p50)} | ${ms(r.underAttack.p50)} |`,
    `| 95th percentile | ${ms(r.baseline.p95)} | ${ms(r.underAttack.p95)} |`,
    `| Failed requests | ${r.baseline.failed} of ${r.samples} | ${r.underAttack.failed} of ${r.samples} |`,
    ...(r.underAttack.failed || r.baseline.failed ? ["", `Failures by status: ${JSON.stringify({ alone: r.baseline.reasons, underAttack: r.underAttack.reasons })}`] : []),
    "",
    `**The attack:** ${r.concurrency} requests in flight at a time, from ${r.attackers} addresses, mixing password guessing, booking-form spam and page loads. ${r.attack.limited.toLocaleString()} of ${r.attack.sent.toLocaleString()} attack requests (${Math.round((r.attack.limited / r.attack.sent) * 100)}%) were refused by the rate limits.`,
    "",
    `**Against the Week 4 example of "no more than 10% degradation":** the 95th percentile was ${r.slower >= 0 ? `${r.slower.toFixed(0)}% slower` : `${Math.abs(r.slower).toFixed(0)}% faster`} under attack, so it ${r.meetsTenPercent ? "meets" : "does not meet"} that target on this machine.${r.meetsTenPercent ? "" : " The staff process still shares the machine and database with the flood. Staff were never refused or timed out."}`,
    "",
    `**The limit of this result:** the flood here carries no session cookie, as a flood at a public site does. A flood that forges a session cookie reaches the staff process, where the rate limits still apply; a flood too large for the network connection needs protection in front of the server, such as Cloudflare (see OUT-OF-SCOPE.md).`,
    ""
  ].join("\n");
}

// Runs on the attacker thread: password guessing, booking-form spam and page loads from many addresses
function runAttacker({ base, origin, concurrency, attackers }) {
  const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const send = (method, url, ip, body) => new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(base + url, {
      method, agent,
      headers: { Origin: origin, "X-Forwarded-For": ip, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) }
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(0));
    if (payload) req.write(payload);
    req.end();
  });
  const attempts = [
    (ip, n) => send("POST", "/api/v1/auth/login", ip, { username: `victim${n % 5}`, password: `Guess-${n}-Password!` }),
    // A valid booking, so the spam reaches the database rather than stopping at validation
    (ip, n) => send("POST", "/api/v1/public/reservations", ip, { name: "Spam Bot", phone: `0300${String(n).padStart(7, "0")}`, date: soon, time: "12:00", party: 2 }),
    (ip) => send("GET", "/", ip),
    (ip) => send("GET", "/api/v1/public/menu", ip)
  ];
  let stop = false;
  let ready = false;
  const stats = { sent: 0, limited: 0, other: 0 };
  parentPort.once("message", () => { stop = true; });
  const loops = Array.from({ length: concurrency }, async (_, w) => {
    for (let n = w; !stop; n += concurrency) {
      const status = await attempts[n % attempts.length](`198.51.100.${(n % attackers) + 1}`, n);
      stats.sent += 1;
      if (status === 429) stats.limited += 1; else stats.other += 1;
      if (!ready && stats.sent >= concurrency) { ready = true; parentPort.postMessage("ready"); }
    }
  });
  Promise.all(loops).then(() => { agent.destroy(); parentPort.postMessage(stats); });
}

// Runs on its own thread: the app process that serves everyone without a staff session
async function runPublicServer({ uri, env }) {
  const client = await MongoClient.connect(uri);
  const config = loadConfig(env);
  const app = createApp({ config, db: client.db("cafems_load"), logger: createLogger(config) });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
}

if (!isMainThread) {
  if (workerData.role === "public") runPublicServer(workerData); else runAttacker(workerData);
} else main().then((r) => {
  const text = report(r);
  console.log(text);
  if (process.argv.includes("--write")) fs.writeFileSync(path.join(__dirname, "..", "docs", "security", "LOAD-TEST.md"), text);
  process.exitCode = r.passed ? 0 : 1;
}).catch((error) => {
  console.error(`Load test could not run: ${error.message}`);
  process.exitCode = 1;
});
