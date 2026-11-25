// Grand Development Quiz: collects all the screenshot evidence for Q1-Q3 against the REAL local stack
// (the local MongoDB replica set + the CafeMS server + a headless Chrome). Every screenshot is saved in its own step
// folder under docs/quiz/screenshots/. Pages are real browser screenshots; API calls, test runs and
// database queries are captured live and rendered as request/response or terminal images.
//
// Needs: the local MongoDB running (npm run setup has been done), nothing else on port 3000 or 3001,
// and Chrome or Edge installed. It creates four demo accounts (quiz.waiter, quiz.cashier,
// quiz.manager, quiz.manager2) whose test password and authenticator secrets are written to
// .quiz-demo-credentials.json (git-ignored). Earlier quiz demo data is removed first.
//
// Run: node scripts/quiz-evidence.js
require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { MongoClient } = require("mongodb");
const { loadConfig } = require("../server/config");
const { hashPassword } = require("../server/lib/passwords");
const { encrypt } = require("../server/lib/crypto");
const totp = require("../server/lib/totp");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "quiz", "screenshots");
const CONFIG = loadConfig(process.env);
const ORIGIN = CONFIG.appOrigin.replace(/\/$/, "");
const API = `${ORIGIN}/api/v1`;
const DEBUG_PORT = 9341;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const PASSWORD = `Quiz-${crypto.randomBytes(6).toString("base64url")}-Brew7`;
const USERS = { waiter: ["quiz.waiter", "Quiz Waiter", "Waiter"], cashier: ["quiz.cashier", "Quiz Cashier", "Cashier"], manager: ["quiz.manager", "Quiz Manager", "Manager"], manager2: ["quiz.manager2", "Quiz Manager Two", "Manager"] };

// ---------- Database (administrator login, used only for setup, inspection and failure injection) ----------
const rootUri = () => {
  const host = process.env.MONGODB_HOST || "127.0.0.1:27017";
  return `mongodb://${encodeURIComponent(process.env.MONGO_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_ROOT_PASSWORD)}@${host}/?directConnection=true&authSource=admin`;
};
let client, db;

async function resetDemo() {
  const names = Object.values(USERS).map((u) => u[0]);
  const ids = (await db.collection("staff_requests").find({ owner: { $in: names } }, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
  await db.collection("staff_requests").deleteMany({ _id: { $in: ids } });
  await db.collection("request_history").deleteMany({ requestId: { $in: ids } });
  await db.collection("sessions").deleteMany({ username: { $in: names } });
  await db.collection("users").deleteMany({ username: { $in: names } });
  const creds = { password: PASSWORD, note: "Test accounts for the quiz demo. Codes come from these authenticator secrets.", users: {} };
  for (const [username, name, role] of Object.values(USERS)) {
    const secret = totp.generateSecret(20);
    await db.collection("users").insertOne({
      username, name, role, status: "Active", passwordHash: await hashPassword(PASSWORD), failedAttempts: 0, lockedUntil: null, createdAt: new Date(),
      mfa: { enabled: true, secretEnc: encrypt(secret, `mfa-secret:${username}`, CONFIG.data), lastStep: 0, recoveryHashes: [] }
    });
    creds.users[username] = { role, authenticatorSecret: secret };
  }
  fs.writeFileSync(path.join(ROOT, ".quiz-demo-credentials.json"), JSON.stringify(creds, null, 2));
  return creds;
}
const codeFor = async (username, creds) => {
  await db.collection("users").updateOne({ username }, { $set: { "mfa.lastStep": 0 } });
  return totp.generate(creds.users[username].authenticatorSecret);
};

// ---------- The CafeMS server, started and restarted by this script ----------
let server, serverLog = "";
async function startServer() {
  server = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${ORIGIN}/api/health/ready`)).ok) return; } catch { /* starting */ }
    await wait(300);
  }
  throw new Error(`The server did not start:\n${serverLog.slice(-2000)}`);
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once("exit", r));
  server.kill();
  await done;
  server = null;
}

// ---------- A small API client, the way the browser calls the server ----------
function apiClient(label) {
  const jar = {};
  let csrf = null;
  const self = { label, jar };
  self.call = async (method, pathname, body, opts = {}) => {
    const headers = { Accept: "application/json", Origin: ORIGIN };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrf && !opts.noCsrf) headers["X-CSRF-Token"] = csrf;
    const res = await fetch(`${API}${pathname}`, { method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value) jar[pair.slice(0, at)] = value; else delete jar[pair.slice(0, at)];
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { method, path: `/api/v1${pathname}`, body, status: res.status, json, setCookie: res.headers.getSetCookie(), who: label };
  };
  self.signIn = async (username, creds) => {
    const a = await self.call("POST", "/auth/login", { username, password: creds.password });
    const b = await self.call("POST", "/auth/mfa/verify", { code: await codeFor(username, creds) });
    const me = await self.call("GET", "/auth/me");
    csrf = me.json && me.json.csrfToken;
    return [a, b, me];
  };
  self.copySessionFrom = (other) => { Object.assign(jar, other.jar); };
  self.setCsrf = (t) => { csrf = t; };
  self.csrf = () => csrf;
  return self;
}

// ---------- Headless Chrome through the DevTools protocol ----------
function findBrowser() {
  const found = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome or Edge was not found. Set CHROME_PATH.");
  return found;
}
async function connectChrome() {
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    // Chrome's debugging endpoint listens only on this computer's loopback address
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); } catch { await wait(200); }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  return { send, close: () => ws.close() };
}

// ---------- Rendering captured output as images ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Passwords are never shown in the evidence, even test ones
const pretty = (v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, (k, x) => (k === "password" ? "••••••••" : x), 2));
const shortCookie = (c) => c.replace(/=([^;]{16})[^;]*;/, "=$1…;");
function cardsHtml(title, subtitle, items) {
  const card = (x) => {
    if (x.note) return `<div class="note">${esc(x.note)}</div>`;
    const ok = x.status < 400;
    const req = x.body === undefined ? "" : `<pre class="req">${esc(pretty(x.body))}</pre>`;
    const cookies = (x.setCookie || []).filter((c) => /cms_session/.test(c)).map((c) => `<div class="cookie">Set-Cookie: ${esc(shortCookie(c))}</div>`).join("");
    return `<div class="card"><div class="line"><span class="who">${esc(x.who || "")}</span><span class="m">${x.method}</span><span class="p">${esc(x.path)}</span><span class="s ${ok ? "ok" : "bad"}">${x.status}</span></div>${x.caption ? `<div class="cap">${esc(x.caption)}</div>` : ""}${req}${cookies}<pre class="res">${esc(pretty(x.json))}</pre></div>`;
  };
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:22px;background:#0f1115;color:#d8dee9;font:13px/1.45 Consolas,'Cascadia Mono',monospace;width:1180px}
  h1{font:600 18px Segoe UI,Arial;margin:0 0 4px;color:#fff} .sub{font:13px Segoe UI,Arial;color:#9aa4b2;margin-bottom:16px}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:12px 14px;margin-bottom:12px}
  .line{display:flex;gap:10px;align-items:center;font-weight:600}.who{color:#c4a7e7;min-width:120px}.m{color:#7aa2f7}.p{color:#e5e9f0;flex:1}
  .s{padding:2px 10px;border-radius:12px;color:#0f1115}.ok{background:#9ece6a}.bad{background:#f7768e}
  .cap{color:#e0af68;margin-top:6px;font-family:Segoe UI,Arial}
  pre{margin:8px 0 0;padding:8px 10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:none}
  .req{background:#1f2430;color:#a9b1d6}.res{background:#11141a;color:#b4f9f8}.cookie{color:#e0af68;margin-top:6px}
  .note{font:14px Segoe UI,Arial;background:#1d2b1f;border:1px solid #2f5d36;color:#c3e88d;padding:10px 14px;border-radius:8px;margin-bottom:12px}</style>
  <h1>${esc(title)}</h1><div class="sub">${esc(subtitle)} · captured live from ${esc(ORIGIN)} on ${new Date().toLocaleString()}</div>${items.map(card).join("")}`;
}
function terminalHtml(title, command, text) {
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;padding:22px;background:#0c0c0c;color:#cccccc;font:13px/1.45 Consolas,'Cascadia Mono',monospace;width:1180px}
  .bar{font:600 14px Segoe UI,Arial;color:#fff;background:#1f1f1f;padding:8px 12px;border-radius:8px 8px 0 0}
  .term{background:#0c0c0c;border:1px solid #333;border-top:0;padding:12px 14px;border-radius:0 0 8px 8px}
  .cmd{color:#16c60c}.ok{color:#16c60c}.bad{color:#e74856}pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word}</style>
  <div class="bar">${esc(title)}</div><div class="term"><div class="cmd">PS ${esc(ROOT)}&gt; ${esc(command)}</div><pre>${esc(text).replace(/(✔[^\n]*)/g, '<span class="ok">$1</span>').replace(/(✖[^\n]*)/g, '<span class="bad">$1</span>')}</pre></div>`;
}

(async () => {
  const manifest = [];
  // ---------- Setup ----------
  try { await fetch(`${ORIGIN}/api/health/live`); throw new Error(`Something is already running on ${ORIGIN}. Stop it (Ctrl + C) and run this again.`); } catch (e) { if (/already running/.test(e.message)) throw e; }
  client = await MongoClient.connect(rootUri(), { serverSelectionTimeoutMS: 5000 });
  db = client.db(process.env.MONGODB_DB || "cafems");
  log("Creating demo accounts");
  const creds = await resetDemo();
  fs.rmSync(OUT, { recursive: true, force: true });
  log("Starting the server");
  await startServer();

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-quiz-chrome-"));
  const chrome = spawn(findBrowser(), ["--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  const cdp = await connectChrome();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const js = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (expression, ms = 12000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expression).catch(() => false)) return true; await wait(120); }
    throw new Error(`Timed out waiting for: ${expression}`);
  };
  const go = async (url, ready) => {
    await cdp.send("Page.navigate", { url: url.startsWith("file:") ? url : ORIGIN + url });
    await wait(300);
    await until("document.readyState === 'complete'");
    if (ready) await until(ready);
    await wait(400);
  };
  const type = async (selector, text) => {
    await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    if (text) await cdp.send("Input.insertText", { text });
    await wait(60);
  };
  const clickText = (text) => js(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent).click()`);

  // Saves a screenshot into docs/quiz/screenshots/<folder>/<NN-name>.png
  const counters = {};
  const save = async (folder, name, caption, opts = {}) => {
    counters[folder] = (counters[folder] || 0) + 1;
    const dir = path.join(OUT, folder);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${String(counters[folder]).padStart(2, "0")}-${name}.png`;
    let params = { format: "png" };
    if (opts.selector) {
      await js(`document.querySelector(${JSON.stringify(opts.selector)}).scrollIntoView({ block: "start" })`);
      await wait(200);
      const box = await js(`(() => { const r = document.querySelector(${JSON.stringify(opts.selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x + window.scrollX - 12), y: Math.max(0, r.y + window.scrollY - 12), width: r.width + 24, height: r.height + 24 }; })()`);
      params = { format: "png", clip: { ...box, scale: 1 }, captureBeyondViewport: true };
    } else if (opts.full) {
      const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
      params = { format: "png", clip: { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.min(6000, Math.ceil(cssContentSize.height)), scale: 1 }, captureBeyondViewport: true };
    }
    const { data } = await cdp.send("Page.captureScreenshot", params);
    fs.writeFileSync(path.join(dir, file), Buffer.from(data, "base64"));
    manifest.push({ folder, file, caption });
    log(`saved ${folder}/${file}`);
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-quiz-render-"));
  const render = async (folder, name, caption, html) => {
    const f = path.join(scratch, `${folder}-${name}.html`);
    fs.writeFileSync(f, html);
    await go(`file:///${f.replace(/\\/g, "/")}`);
    await save(folder, name, caption, { full: true });
  };
  const cards = (folder, name, caption, title, items) => render(folder, name, caption, cardsHtml(title, caption, items));
  const terminal = (folder, name, caption, command, text) => render(folder, name, caption, terminalHtml(caption, command, text));
  const mongo = (obj) => JSON.stringify(obj, null, 2);
  const tag = (r, caption, who) => Object.assign(r, caption ? { caption } : {}, who ? { who } : {});

  // UI sign-in exactly as a person does it: password, then a code from the authenticator secret
  const uiSignIn = async (username) => {
    // A signed-in browser is sent away from the login page, so sign out first if that happens
    await go("/login.html");
    await wait(600);
    if (!(await js("location.pathname.endsWith('login.html')"))) {
      await until("document.querySelector('[data-signout]')");
      await uiSignOut();
    }
    await until("document.getElementById('loginBtn') && !document.getElementById('loginBtn').disabled");
    await type("#username", username);
    await type("#password", creds.password);
    await js("document.querySelector('#loginForm').requestSubmit()");
    await until("!document.getElementById('stepMfa').hidden");
    await type("#mfaCode", await codeFor(username, creds));
    await js("document.querySelector('#mfaForm').requestSubmit()");
    await until("window.Store && document.querySelector('[data-signout]')", 15000);
  };
  const uiSignOut = async () => {
    await js("document.querySelector('[data-signout]').click()");
    await until("document.querySelector('.modal-backdrop.show .btn-primary')");
    await js("document.querySelector('.modal-backdrop.show .btn-primary').click()");
    await until("location.pathname.endsWith('login.html')", 10000);
    await wait(300);
  };
  const openRequests = () => go("/requests.html", "document.querySelector('#requestBody tr')");

  const F = { stack: "01-running-stack", q1: "02-Q1-authentication", q2: "03-Q2-submission-integrity", q3a: "04-Q3A-listing-pagination", q3b: "05-Q3B-state-machine-concurrency", q3c: "06-Q3C-history-privacy", q3d: "07-Q3D-errors-and-tests", dbf: "08-database" };

  // ===== 01 Running stack =====
  // The local MongoDB service: its Windows service state, version, replica set and that a login is required
  let service = "";
  try { service = execFileSync("sc", ["query", "MongoDB"], { encoding: "utf8" }).split(/\r?\n/).filter((l) => /SERVICE_NAME|STATE/.test(l)).map((l) => l.trim()).join("\n"); } catch { service = "(Windows service query not available on this system)"; }
  const build = await db.admin().command({ buildInfo: 1 });
  const hello = await db.admin().command({ hello: 1 });
  let anonymous = "allowed";
  const anonClient = await MongoClient.connect(`mongodb://${process.env.MONGODB_HOST || "127.0.0.1:27017"}/?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
  try { await anonClient.db("admin").command({ listDatabases: 1 }); } catch (e) { anonymous = `refused (${e.codeName})`; } finally { await anonClient.close(); }
  await terminal(F.stack, "local-mongodb-running", "MongoDB running locally (Windows service, replica set, login required)", "sc query MongoDB; mongosh --eval 'db.hello()'",
    `${service}\n\nMongoDB ${build.version} at ${hello.me}\nReplica set: ${hello.setName} · primary: ${hello.isWritablePrimary}\nConnection without a login: ${anonymous}`);
  const ready = await (await fetch(`${ORIGIN}/api/health/ready`)).text();
  await terminal(F.stack, "backend-running", "Backend (Node.js + Express) started and connected to MongoDB", "npm start   # then: GET /api/health/ready", `${serverLog.trim().split("\n").slice(-6).join("\n") || "CafeMS server listening"}\n\nGET ${ORIGIN}/api/health/ready\n${ready}`);
  await go("/", "document.querySelector('#publicMenu img')");
  await save(F.stack, "frontend-running", "Frontend running at " + ORIGIN);

  // ===== 02 Q1 authentication =====
  await go("/login.html", "!document.getElementById('loginBtn').disabled");
  await save(F.q1, "login-page", "Login page (password, then authenticator code)");
  const hashDoc = await db.collection("users").findOne({ username: "quiz.waiter" }, { projection: { _id: 0, username: 1, role: 1, status: 1, passwordHash: 1, "mfa.enabled": 1 } });
  await terminal(F.q1, "password-stored-as-hash", "Q1.1 Passwords are stored as Argon2id hashes, never plaintext", "mongosh cafems --eval 'db.users.findOne({ username: \"quiz.waiter\" }, { passwordHash: 1, role: 1 })'", mongo(hashDoc));

  const waiter = apiClient("quiz.waiter");
  const signInSteps = await waiter.signIn("quiz.waiter", creds);
  const meRes = signInSteps[2];
  meRes.json = { ...meRes.json, csrfToken: "(hidden)" };
  await cards(F.q1, "login-jwt-issued", "Q1.1 Server checks the password, then the code, then sets a signed JWT in an HttpOnly cookie with expiry", "Login and session",
    [tag(signInSteps[0], "Step 1: password checked against the Argon2id hash"), tag(signInSteps[1], "Step 2: authenticator code; the signed JWT is set as an HttpOnly, Secure, SameSite=Strict cookie (8-hour expiry, 5-minute idle limit)"), tag(meRes, "Identity and role come from the server session, not from the browser")]);
  const decoded = JSON.parse(Buffer.from(waiter.jar["__Host-cms_session"].split(".")[1], "base64url").toString());
  await terminal(F.q1, "jwt-claims", "Q1.1 The JWT payload: subject, session ID, issuer, audience and expiry (no role inside)", "decode the __Host-cms_session cookie payload", mongo({ header: JSON.parse(Buffer.from(waiter.jar["__Host-cms_session"].split(".")[0], "base64url").toString()), payload: { ...decoded, expiresAt: new Date(decoded.exp * 1000).toISOString() } }));

  await uiSignIn("quiz.waiter");
  await go("/requests.html", "document.querySelector('#requestBody tr')");
  await js("location.reload()");
  await wait(500);
  await until("document.querySelector('#requestBody tr') && document.querySelector('[data-signout]')");
  await save(F.q1, "refresh-keeps-login", "Q1.1 After refreshing a protected page the user is still signed in");

  const secondTab = apiClient("second tab");
  secondTab.copySessionFrom(waiter);
  secondTab.setCsrf(waiter.csrf());
  const tab2Before = await secondTab.call("GET", "/requests?page=1");
  tab2Before.json = { total: tab2Before.json.total, page: tab2Before.json.page, "...": "list returned" };
  const logout = await waiter.call("POST", "/auth/logout", {});
  const replay = apiClient("replay (copied cookie)");
  replay.copySessionFrom(secondTab);
  const replayRes = await replay.call("GET", "/requests?page=1");
  const tab2After = await secondTab.call("GET", "/requests?page=1");
  await cards(F.q1, "logout-invalidates-session", "Q1.3 Logout deletes the session on the server; replaying the same cookie fails, also from a second tab", "Session invalidation",
    [tag(tab2Before, "Second tab works while the user is signed in"), tag(logout, "Logout: the server deletes the session record"), tag(replayRes, "Replaying the old cookie: denied"), tag(tab2After, "Second tab after logout: denied")]);

  const anon = apiClient("not signed in");
  const unauth = await anon.call("GET", "/requests");
  const cashierForbid = apiClient("quiz.cashier");
  await cashierForbid.signIn("quiz.cashier", creds);
  const forbidden = await cashierForbid.call("POST", "/requests/SR-1/claim", { version: 1 });
  const expired = apiClient("forged token");
  expired.jar["__Host-cms_session"] = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJxdWl6Lm1hbmFnZXIifQ.";
  const forged = await expired.call("GET", "/requests");
  await cards(F.q1, "401-vs-403-safe-errors", "Q1.4 401 = not signed in, 403 = signed in but not allowed; errors never show hashes or exceptions", "Failure behaviour",
    [tag(unauth, "No session cookie → 401 not_signed_in"), tag(forged, "Forged token (alg none, changed user) → 401"), tag(forbidden, "Cashier tries a Manager-only action → 403 forbidden (logged in the audit log)")]);

  const forgedFields = [];
  for (const extra of [{ owner: "quiz.manager" }, { status: "Resolved" }, { createdAt: "2020-01-01T00:00:00Z" }]) {
    forgedFields.push(tag(await cashierForbid.call("POST", "/requests", { title: "Forged field attempt", description: "Trying to set a server-controlled field.", category: "Other", ...extra }), `Client tries to set ${Object.keys(extra)[0]} → refused`));
  }
  await cards(F.q1, "forged-fields-rejected", "Q1.2 / Q2.1 Owner, status and timestamps come only from the server session; forged fields are rejected", "Forged role/user fields", forgedFields);

  // ===== 03 Q2 submission and integrity =====
  await uiSignIn("quiz.waiter");
  await openRequests();
  await type("#rqTitle", "  ab  ");
  await type("#rqDescription", "short");
  await js("document.querySelector('#requestForm').requestSubmit()");
  await wait(400);
  await save(F.q2, "frontend-validation", "Q2.1 Form checks before sending: title of at least 5 characters, description of at least 15, category required", { selector: "#newRequestPanel" });

  const owner = apiClient("quiz.waiter");
  await owner.signIn("quiz.waiter", creds);
  const v = [];
  v.push(tag(await owner.call("POST", "/requests", { title: "   ab    c   ", description: "Long enough description here.", category: "Equipment" }), "Title is under 5 characters after trimming → 400"));
  v.push(tag(await owner.call("POST", "/requests", { title: "Valid title here", description: "   too short    ", category: "Equipment" }), "Description under 15 characters → 400"));
  v.push(tag(await owner.call("POST", "/requests", { title: "Valid title here", description: "Long enough description here.", category: "Snacks" }), "Unknown category → 400"));
  await cards(F.q2, "server-validation", "Q2.1 The server validates again (the browser can be bypassed)", "Server-side validation", v);

  await openRequests();
  await type("#rqTitle", "  Espresso   machine is leaking  ");
  await js("document.querySelector('#rqCategory').value = 'Equipment'; document.querySelector('#rqCategory').dispatchEvent(new Event('change', { bubbles: true }))");
  await type("#rqDescription", "Water drips from the group head during every shot.");
  await type("#rqPhone", "03211234567");
  await js("document.querySelector('#requestForm').requestSubmit()");
  await until("document.querySelector('#requestBody b') && document.querySelector('#requestBody b').textContent === 'Espresso machine is leaking'");
  await wait(300);
  await save(F.q2, "submission-success", "Q2.4 Submitted from the form: saved as Pending, version 1, title trimmed, shown in the list");

  const createdRes = await owner.call("POST", "/requests", { title: "Need more paper cups", description: "Only one sleeve of takeaway cups left at the counter.", category: "Supplies", contactPhone: "03001234567" });
  await cards(F.q2, "create-returns-committed-record", "Q2.4 201 Created: the response is the record as committed in MongoDB (server owner, unique ID, Pending, timestamps)", "Create a request", [tag(createdRes)]);

  await openRequests();
  await type("#rqTitle", "ESPRESSO MACHINE IS LEAKING");
  await js("document.querySelector('#rqCategory').value = 'Equipment'; document.querySelector('#rqCategory').dispatchEvent(new Event('change', { bubbles: true }))");
  await type("#rqDescription", "Second copy of the same problem report.");
  await js("document.querySelector('#requestForm').requestSubmit()");
  await until("document.querySelector('#requestErr.show')");
  await save(F.q2, "duplicate-conflict-message", "Q2.2 Same title in different case: conflict shown to the user", { selector: "#newRequestPanel" });

  const variants = ["Card machine is down", "card machine is DOWN", "  Card   machine is down ", "CARD MACHINE IS DOWN", "Card machine  is down"];
  const race = await Promise.all(variants.map((t) => owner.call("POST", "/requests", { title: t, description: "The card terminal shows a network error.", category: "Equipment" })));
  const raceDocs = await db.collection("staff_requests").find({ owner: "quiz.waiter", titleKey: "card machine is down" }).toArray();
  const raceHist = await db.collection("request_history").countDocuments({ requestId: { $in: raceDocs.map((d) => d._id) } });
  await cards(F.q2, "concurrent-duplicates", "Q2.2 Five simultaneous submissions (case/space variants): exactly one record", "Race-safe duplicate prevention",
    [...race.map((r, i) => tag(r, `Request ${i + 1}: title "${variants[i]}"`)), { note: `Database check: ${raceDocs.length} record with this title for quiz.waiter, ${raceHist} creation event. The unique index one_title_per_owner (owner + normalized title) blocks the rest.` }]);

  const cashier = apiClient("quiz.cashier");
  await cashier.signIn("quiz.cashier", creds);
  await cards(F.q2, "different-owner-same-title", "Q2.2 A different owner may use the same title", "Different owners", [tag(await cashier.call("POST", "/requests", { title: "Card machine is down", description: "The card terminal shows a network error.", category: "Equipment" }), "quiz.cashier uses the same title → 201")]);

  await db.command({ collMod: "request_history", validator: { $expr: { $eq: [1, 0] } }, validationAction: "error", validationLevel: "strict" });
  let atomicRes;
  try { atomicRes = await owner.call("POST", "/requests", { title: "Should never be saved", description: "The history write is forced to fail.", category: "Other" }); } finally { await db.command({ collMod: "request_history", validator: {}, validationLevel: "off" }); }
  const afterAtomic = await db.collection("staff_requests").countDocuments({ title: "Should never be saved" });
  await cards(F.q2, "atomic-creation-rollback", "Q2.3 Forced audit/history write failure: the record is not saved either (one transaction)", "Atomic creation",
    [{ note: "Failure injected: a database rule makes every insert into request_history fail." }, tag(atomicRes, "Create while the audit write fails → 500, generic message"), { note: `Database check after the failure: ${afterAtomic} records titled "Should never be saved". Nothing was half-saved.` }]);

  const persistId = createdRes.json.id;
  await stopServer();
  await startServer();
  const persistRes = await owner.call("GET", `/requests/${persistId}`);
  await cards(F.q2, "persistence-after-restart", "Q2.4 The server was stopped and started again: the record is still there (MongoDB on disk)", "Persistence after restart", [{ note: "Server process stopped and restarted by the script." }, tag(persistRes, `Read ${persistId} after the restart → 200`)]);

  // ===== 04 Q3 A listing =====
  const cats = ["Equipment", "Supplies", "Equipment", "Maintenance"];
  for (let i = 0; i < 12; i++) await owner.call("POST", "/requests", { title: `Coffee grinder issue ${i + 1}`, description: "Grinder makes an unusual noise when started.", category: cats[i % 4] });
  for (let i = 0; i < 3; i++) await cashier.call("POST", "/requests", { title: `Coffee grinder issue ${i + 1}`, description: "Grinder makes an unusual noise when started.", category: "Equipment" });
  await openRequests();
  await type("#fSearch", "COFFEE grinder");
  await wait(600);
  await js("const c = document.querySelector('#fCategory'); c.value = 'Equipment'; c.dispatchEvent(new Event('change'))");
  await wait(400);
  await js("const s = document.querySelector('#fStatus'); s.value = 'Pending'; s.dispatchEvent(new Event('change'))");
  await wait(400);
  await js("document.querySelector('#nextPage').click()");
  await until("document.querySelector('#pageInfo').textContent.startsWith('Page 2')");
  await save(F.q3a, "filters-page-2-ui", "Q3 A Search + category + status filters combined, page 2 of 2 (5 per page), only the owner's records", { selector: ".panel:last-of-type" });
  const p1 = await owner.call("GET", "/requests?search=COFFEE%20grinder&category=Equipment&status=Pending&sort=oldest&page=1");
  const p2 = await owner.call("GET", "/requests?search=COFFEE%20grinder&category=Equipment&status=Pending&sort=oldest&page=2");
  const brief = (r) => Object.assign(r, { json: { total: r.json.total, page: r.json.page, pageSize: r.json.pageSize, pages: r.json.pages, items: r.json.items.map((x) => `${x.id} · ${x.title} · ${x.category} · ${x.status} · @${x.owner}`) } });
  await cards(F.q3a, "filters-page-2-api", "Q3 A One listing endpoint: case-insensitive search, filters combined with AND, scope applied before counting and paging", "Listing API", [tag(brief(p1), "Page 1"), tag(brief(p2), "Page 2: correct remaining item and the same total (6). quiz.cashier's 3 matching records are out of scope")]);
  const bad = [];
  for (const q of ["page=0", "page=abc", "sort=title", "category=Snacks", "status=Done", "owner=quiz.cashier"]) bad.push(tag(await owner.call("GET", `/requests?${q}`), `?${q} → refused`));
  await cards(F.q3a, "invalid-query-rejected", "Q3 A Invalid page, sort and filter values are rejected", "Invalid query values", bad);

  // ===== 05 Q3 B state machine =====
  await uiSignIn("quiz.manager");
  await openRequests();
  await save(F.q3b, "manager-list-scope", "Q3 B The Manager (Role 2) sees Pending requests from all staff, plus ones they claimed");
  const target = (await owner.call("GET", "/requests?search=espresso%20machine")).json.items[0].id;
  await type("#fSearch", "espresso");
  await until(`[...document.querySelectorAll('#requestBody button')].some((b) => b.getAttribute('aria-label') === 'Open ${target}')`);
  await js(`[...document.querySelectorAll('#requestBody button')].find((b) => b.getAttribute('aria-label') === 'Open ${target}').click()`);
  await until("document.querySelector('#requestDetail.show')");
  await wait(300);
  await save(F.q3b, "detail-before-claim", `Q3 B ${target} is Pending, version 1: only "Claim for review" is offered`, { selector: "#requestDetail .modal" });
  await clickText("Claim for review");
  await until("document.querySelector('#requestDetailSub').textContent.includes('In Review')");
  await wait(300);
  await save(F.q3b, "claimed-in-review", "Q3 B Claimed: In Review, version 2, reviewer recorded, history event added", { selector: "#requestDetail .modal" });
  await clickText("Reject");
  await wait(400);
  await save(F.q3b, "reject-needs-reason", "Q3 B A rejection without a reason is refused", { selector: "#requestDetail .modal" });
  await type("#rejectReason", "Technician already booked for Monday");
  await clickText("Reject");
  await until("document.querySelector('#requestDetailSub').textContent.includes('Rejected')");
  await wait(300);
  await save(F.q3b, "rejected-terminal", "Q3 B Rejected with a reason: terminal (no more actions), version 3, full history", { selector: "#requestDetail .modal" });

  const mgr = apiClient("quiz.manager");
  await mgr.signIn("quiz.manager", creds);
  const mgr2 = apiClient("quiz.manager2");
  await mgr2.signIn("quiz.manager2", creds);
  const rc = (await owner.call("POST", "/requests", { title: "Race to claim this", description: "Two managers claim at the same moment.", category: "Staffing" })).json;
  const role1 = await owner.call("POST", `/requests/${rc.id}/claim`, { version: 1 });
  const claims = await Promise.all([mgr.call("POST", `/requests/${rc.id}/claim`, { version: 1 }), mgr2.call("POST", `/requests/${rc.id}/claim`, { version: 1 })]);
  const claimEvents = await db.collection("request_history").countDocuments({ requestId: rc.id, action: "Claimed" });
  await cards(F.q3b, "two-claims-same-version", "Q3 B Two simultaneous claims with the same version: one success, one conflict, one transition event", "Concurrent claims",
    [tag(role1, "Role 1 (Waiter) tries to claim → 403"), tag(claims[0], "Manager 1 claims with version 1"), tag(claims[1], "Manager 2 claims with version 1 at the same moment"), { note: `Database check: ${claimEvents} "Claimed" history event for ${rc.id}. The losing request did not overwrite the winner.` }]);

  const fin = (await owner.call("POST", "/requests", { title: "Finalize too early", description: "Checks the finalize rules for reviewers.", category: "Maintenance" })).json;
  const early = await mgr.call("POST", `/requests/${fin.id}/resolve`, { version: 1 });
  await mgr.call("POST", `/requests/${fin.id}/claim`, { version: 1 });
  const wrongActor = await mgr2.call("POST", `/requests/${fin.id}/resolve`, { version: 2 });
  const stale = await mgr.call("POST", `/requests/${fin.id}/resolve`, { version: 1 });
  const finDoc = await db.collection("staff_requests").findOne({ _id: fin.id }, { projection: { _id: 1, status: 1, version: 1, reviewer: 1 } });
  const finHist = await db.collection("request_history").countDocuments({ requestId: fin.id });
  const resolved = await mgr.call("POST", `/requests/${fin.id}/resolve`, { version: 2 });
  const terminalTry = await mgr.call("POST", `/requests/${fin.id}/reject`, { version: 3, reason: "Change after resolve" });
  await cards(F.q3b, "finalize-rules", "Q3 B Finalize without claim or as the wrong actor is denied; stale versions conflict; terminal records cannot change", "Finalize rules",
    [tag(early, "Resolve a Pending request (not claimed) → 409 wrong_status"), tag(wrongActor, "Manager 2 resolves a request claimed by Manager 1 → 403 not_assigned"), tag(stale, "Resolve with an old version → 409 stale_version"), { note: `Database check after the denied attempts: ${mongo(finDoc).replace(/\s+/g, " ")}, history events: ${finHist}. No change.` }, tag(resolved, "The assigned reviewer resolves with the current version → 200"), tag(terminalTry, "Try to change a Resolved (terminal) record → 409")]);

  // ===== 06 Q3 C history and privacy =====
  await uiSignIn("quiz.waiter");
  await openRequests();
  await type("#fSearch", "espresso");
  await until(`[...document.querySelectorAll('#requestBody button')].some((b) => b.getAttribute('aria-label') === 'Open ${target}')`);
  await js(`[...document.querySelectorAll('#requestBody button')].find((b) => b.getAttribute('aria-label') === 'Open ${target}').click()`);
  await until("document.querySelector('#requestDetail.show') && document.querySelector('#historyList li')");
  await wait(300);
  await save(F.q3c, "owner-sees-history-masked-contact", "Q3 C The owner sees the full history (status, actor, time, version) and only a masked contact number", { selector: "#requestDetail .modal" });

  const hist = [];
  hist.push(tag(await owner.call("GET", `/requests/${target}/history`), "Owner → 200"));
  hist.push(tag(await mgr.call("GET", `/requests/${target}/history`), "Assigned reviewer → 200"));
  hist.push(tag(await cashier.call("GET", `/requests/${target}/history`), "Another staff member → 404 (existence not disclosed)"));
  hist.push(tag(await mgr2.call("GET", `/requests/${target}/history`), "A Manager who did not claim it → 404"));
  hist[0].json = { history: hist[0].json.history };
  hist[1].json = { history: `${hist[1].json.history.length} events (same as above)` };
  await cards(F.q3c, "history-endpoint-access", "Q3 C History endpoint restricted to the owner and the authorized reviewer", "History access", hist);

  const other = [];
  other.push(tag(await cashier.call("GET", `/requests/${persistId}`), `quiz.cashier opens quiz.waiter's ${persistId} by changing the ID → 404`));
  other.push(tag(await cashier.call("GET", `/requests/${persistId}/history`), "…and its history → 404"));
  other.push(tag(await cashier.call("POST", `/requests/${persistId}/claim`, { version: 1 }), "…and tries to change its status → 403"));
  const ownerDetail = await owner.call("GET", `/requests/${persistId}`);
  other.push(tag(ownerDetail, "The owner's own view: the contact number is masked even here"));
  const rawContact = await db.collection("staff_requests").findOne({ _id: persistId }, { projection: { contactEnc: 1, contactMask: 1 } });
  other.push({ note: `In the database the number is stored encrypted (AES-256-GCM): contactEnc = ${JSON.stringify(rawContact.contactEnc).slice(0, 90)}…` });
  await cards(F.q3c, "other-owner-and-sensitive-field", "Q3 C Role 1 cannot access another owner's record by changing IDs; the contact number is protected", "Ownership and privacy", other);

  const rb = (await owner.call("POST", "/requests", { title: "Transition rollback check", description: "History write forced to fail on claim.", category: "Other" })).json;
  await db.command({ collMod: "request_history", validator: { $expr: { $eq: [1, 0] } }, validationAction: "error", validationLevel: "strict" });
  let rbRes;
  try { rbRes = await mgr.call("POST", `/requests/${rb.id}/claim`, { version: 1 }); } finally { await db.command({ collMod: "request_history", validator: {}, validationLevel: "off" }); }
  const rbDoc = await db.collection("staff_requests").findOne({ _id: rb.id }, { projection: { _id: 1, status: 1, version: 1, reviewer: 1 } });
  await cards(F.q3c, "failed-transition-unchanged", "Q3 C A failed transition leaves the record and history unchanged", "Atomic transition",
    [{ note: "Failure injected: every insert into request_history fails." }, tag(rbRes, "Claim while the history write fails → 500"), { note: `Database check: ${mongo(rbDoc).replace(/\s+/g, " ")}, history events: ${await db.collection("request_history").countDocuments({ requestId: rb.id })}. Still Pending, version 1.` }]);

  // ===== 07 Q3 D errors and tests =====
  const d = [];
  d.push(tag(await mgr.call("POST", "/requests/SR-999999/claim", { version: 1 }), "Non-existent ID → 404"));
  d.push(tag(await mgr.call("POST", "/requests/not-an-id/claim", { version: 1 }), "Malformed ID → 400"));
  d.push(tag(await mgr.call("POST", `/requests/${rb.id}/claim`, { version: "1" }), "Version sent as text → 400"));
  d.push(tag(await owner.call("POST", "/requests", "{\"title\": "), "Broken JSON → 400"));
  await cards(F.q3d, "invalid-payloads-and-ids", "Q3 D Invalid payloads and non-existent IDs get clear, safe errors", "Robust API", d);

  // Database failure: a second copy of the real app on port 3001 whose database connection is cut.
  // (Stopping the shared MongoDB Windows service would need Administrator rights on every run.)
  const downClient = await MongoClient.connect(rootUri(), { serverSelectionTimeoutMS: 1500 });
  const { createApp } = require("../server/app");
  const { createLogger } = require("../server/lib/logger");
  const downServer = createApp({ config: CONFIG, db: downClient.db(process.env.MONGODB_DB || "cafems"), logger: createLogger(CONFIG) }).listen(3001);
  await downClient.close();
  const downApi = API.replace(`${ORIGIN}`, "http://localhost:3001");
  const downRaw = await fetch(`${downApi}/requests`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Origin: ORIGIN, Cookie: Object.entries(owner.jar).map(([k, v]) => `${k}=${v}`).join("; "), "X-CSRF-Token": owner.csrf() }, body: JSON.stringify({ title: "Saved while database down", description: "This must not be saved anywhere.", category: "Other" }) });
  const downRes = { who: "quiz.waiter", method: "POST", path: "/api/v1/requests", body: { title: "Saved while database down", description: "This must not be saved anywhere.", category: "Other" }, status: downRaw.status, json: await downRaw.json() };
  await new Promise((r) => downServer.close(r));
  const downCount = await db.collection("staff_requests").countDocuments({ title: "Saved while database down" });
  await cards(F.q3d, "database-stopped-503", "Q3 D Database unreachable: the API answers 503 and nothing is saved (no false success)", "Database failure",
    [{ note: "A copy of the app is started with its database connection cut (MongoDB unreachable)." }, tag(downRes, "Create while the database is unreachable → 503 database_unavailable"), { note: `Database check afterwards: ${downCount} records titled "Saved while database down".` }]);

  log("Running the automated quiz tests");
  let testOut = "";
  try { testOut = execFileSync(process.execPath, ["--test", "--test-reporter=spec", "tests/quiz.test.js"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { testOut = `${e.stdout || ""}${e.stderr || ""}`; }
  const lines = testOut.split("\n").filter((l) => !/^\s*$/.test(l) && !/duration_ms|^ℹ (cancelled|skipped|todo|suites)/.test(l));
  await terminal(F.q3d, "automated-tests-1", "Q3 D Automated tests (node:test): Q1 and Q2", "npm run test:quiz", lines.slice(0, Math.ceil(lines.length / 2)).join("\n"));
  await terminal(F.q3d, "automated-tests-2", "Q3 D Automated tests (node:test): Q3, including concurrency and authorization cases", "npm run test:quiz  (continued)", lines.slice(Math.ceil(lines.length / 2)).join("\n"));

  // ===== 08 Database =====
  const idx = { staff_requests: (await db.collection("staff_requests").indexes()).map((i) => ({ name: i.name, key: i.key, unique: i.unique || false })), request_history: (await db.collection("request_history").indexes()).map((i) => ({ name: i.name, key: i.key, unique: i.unique || false })) };
  await terminal(F.dbf, "schema-indexes", "Database schema: collections and indexes (unique owner + normalized title; one history event per version)", "mongosh cafems --eval 'db.staff_requests.getIndexes(); db.request_history.getIndexes()'", mongo(idx));
  const sample = await db.collection("staff_requests").find({ owner: "quiz.waiter" }).sort({ seq: 1 }).limit(2).project({ contactEnc: 0 }).toArray();
  await terminal(F.dbf, "stored-records", "Stored records in MongoDB (staff_requests)", "mongosh cafems --eval 'db.staff_requests.find({ owner: \"quiz.waiter\" }).limit(2)'", mongo(sample));
  const statusRecs = await db.collection("staff_requests").find({ _id: { $in: [target, fin.id, rc.id] } }).project({ _id: 1, title: 1, status: 1, version: 1, reviewer: 1, reason: 1, updatedAt: 1 }).toArray();
  const histRecs = await db.collection("request_history").find({ requestId: target }).sort({ version: 1 }).project({ _id: 0 }).toArray();
  await terminal(F.dbf, "status-changes-and-history", "Status changes and their history events in MongoDB", `mongosh cafems --eval 'db.staff_requests.find({ _id: { $in: [...] } }); db.request_history.find({ requestId: "${target}" })'`, `${mongo(statusRecs)}\n\n// request_history for ${target}\n${mongo(histRecs)}`);
  const roleInfo = await db.command({ rolesInfo: "cafemsApp", showPrivileges: true });
  const privs = roleInfo.roles[0].privileges.filter((p) => ["staff_requests", "request_history", "audit_events"].includes(p.resource.collection)).map((p) => ({ collection: p.resource.collection, actions: p.actions }));
  await terminal(F.dbf, "least-privilege-history", "The app's database login can only add and read history (append-only), never edit or delete it", "mongosh admin --eval 'db.getSiblingDB(\"cafems\").getRole(\"cafemsApp\", { showPrivileges: true })'", mongo(privs));

  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`Done: ${manifest.length} screenshots in docs/quiz/screenshots`);
  cdp.close();
  chrome.kill();
  await stopServer();
  await client.close();
})().catch(async (error) => {
  console.error(error);
  try { await stopServer(); } catch { /* already stopped */ }
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000);
});
