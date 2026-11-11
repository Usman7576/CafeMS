// Project Activity 5: runs every frontend security test case in a real Chrome window and records the
// evidence. It starts a throwaway copy of CafeMS on an in-memory database (nothing touches real data),
// drives Chrome through the DevTools protocol, and writes:
//   docs/activity-5/screenshots/*.png   one screenshot per step
//   docs/activity-5/test-results.json   the input, expected result and actual result of every case
// The actual results are read from the page itself (messages shown, storage contents, whether a script
// ran), never written in by hand.
//
// Run: node scripts/activity5-evidence.js   (needs Google Chrome or Microsoft Edge installed)
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "activity-5");
const SHOTS = path.join(OUT, "screenshots");
const PORT = 3017;
const ORIGIN = `http://localhost:${PORT}`;
const DEBUG_PORT = 9333;

const h = require(path.join(ROOT, "tests", "helpers.js"));
const { loadConfig } = require(path.join(ROOT, "server", "config"));
const { createApp } = require(path.join(ROOT, "server", "app"));
const { seedCatalog } = require(path.join(ROOT, "scripts", "seed-data.js"));
const totp = require(path.join(ROOT, "server", "lib", "totp"));

const results = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome or Edge was not found. Set CHROME_PATH to the browser's executable.");
  return found;
}

// ---------- A small DevTools protocol client using Node's built-in WebSocket ----------
async function connect() {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); } catch { await wait(200); }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) handlers.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, on: (fn) => handlers.push(fn), close: () => ws.close() };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (f.endsWith(".png")) fs.unlinkSync(path.join(SHOTS, f));

  // ---------- Throwaway server ----------
  const { db, stop } = await h.startDb();
  await seedCatalog(db);
  const config = loadConfig(h.testEnv({ APP_ORIGIN: ORIGIN, NODE_ENV: "development" }));
  const relaxed = { ...config, limits: { ...config.limits, authPer15Minutes: 100000, apiPerMinute: 100000, userPerMinute: 100000, sitePerMinute: 100000, publicReadsPerMinute: 100000 } };
  const app = createApp({ config: relaxed, db, logger: require("pino")({ level: "error" }) });
  const manager = await h.createUser(db, relaxed, { role: "Manager", username: "activity.manager", name: "Activity Manager", password: "Brew-House-58-Lantern" });
  const admin = await h.createUser(db, relaxed, { role: "Admin", username: "activity.admin", name: "Activity Admin", password: "Brew-House-58-Lantern" });
  const server = await new Promise((resolve) => { const s = app.listen(PORT, () => resolve(s)); });

  // ---------- Files for the file-selection tests ----------
  const sharp = require("sharp");
  const files = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-a5-"));
  const file = (name, bytes) => { const p = path.join(files, name); fs.writeFileSync(p, bytes); return p; };
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#7a4a2a" } }).png().toBuffer();
  const FILES = {
    valid: file("flat-white.png", png),
    exe: file("setup.exe", Buffer.concat([Buffer.from("MZ"), crypto.randomBytes(4000)])),
    pdf: file("menu-card.pdf", Buffer.from("%PDF-1.7\n% test document\n")),
    big: file("large-photo.png", Buffer.concat([png.subarray(0, 8), crypto.randomBytes(3 * 1024 * 1024)])),
    fake: file("not-really.png", Buffer.from("<?php echo 'this is a script, not a picture'; ?>")),
    double: file("photo.php.png", png),
    svg: file("logo.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>"))
  };

  // ---------- Browser ----------
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cafems-a5-chrome-"));
  const chrome = spawn(findBrowser(), [
    "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1280,900", "about:blank"
  ], { stdio: "ignore" });
  const cdp = await connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  const dialogs = [];
  const posts = [];
  cdp.on((msg) => {
    if (msg.method === "Page.javascriptDialogOpening") {
      dialogs.push(msg.params.message);
      cdp.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
    }
    if (msg.method === "Network.requestWillBeSent" && msg.params.request.method !== "GET") posts.push({ url: msg.params.request.url, body: msg.params.request.postData || "" });
  });

  const js = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  const until = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expression).catch(() => false)) return true; await wait(100); }
    throw new Error(`Timed out waiting for: ${expression}`);
  };
  const go = async (url, ready) => {
    await cdp.send("Page.navigate", { url: ORIGIN + url });
    await wait(300);
    await until("document.readyState === 'complete'");
    if (ready) await until(ready);
    await wait(250);
  };
  let shotNo = 0;
  const shot = async (name, selector) => {
    shotNo += 1;
    const fileName = `${String(shotNo).padStart(2, "0")}-${name}.png`;
    let clip;
    if (selector) {
      await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
      await wait(150);
      const box = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.x + window.scrollX - 16), y: Math.max(0, r.y + window.scrollY - 16), width: r.width + 32, height: r.height + 32 }; })()`);
      clip = { ...box, scale: 1 };
    }
    const { data } = await cdp.send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
    fs.writeFileSync(path.join(SHOTS, fileName), Buffer.from(data, "base64"));
    return `screenshots/${fileName}`;
  };
  // Types into a field the way a person does, so the page's own input listeners run
  const type = async (selector, text) => {
    await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    if (text) await cdp.send("Input.insertText", { text });
    await wait(60);
  };
  // Sets a value directly, the way an attacker bypasses maxlength with the developer tools
  const force = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const submit = (form) => js(`document.querySelector(${JSON.stringify(form)}).requestSubmit()`);
  const errors = (form) => js(`Array.from(document.querySelectorAll(${JSON.stringify(form + " .field-error.show")})).map((e) => e.id.replace(/-error$/, "") + ": " + e.textContent)`);
  const setFile = async (selector, filePath) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [filePath] });
    await wait(400);
  };
  // Password first, then a code made from the person's authenticator secret, exactly as a person signs in
  const signInAs = async (user, home) => {
    await go("/login.html", "!document.getElementById('loginBtn').disabled");
    await type("#username", "  " + user.username + "  ");
    await type("#password", user.password);
    await submit("#loginForm");
    await until("!document.getElementById('stepMfa').hidden");
    await db.collection("users").updateOne({ username: user.username }, { $set: { "mfa.lastStep": 0 } });
    await type("#mfaCode", totp.generate(user.secret));
    await submit("#mfaForm");
    await until(`location.pathname.endsWith(${JSON.stringify(home)}) && window.Store && document.querySelector('[data-signout]')`, 15000);
  };
  const signOut = async () => {
    await js("document.querySelector('[data-signout]').click()");
    await until("document.querySelector('.modal-backdrop.show .btn-primary')");
    await js("document.querySelector('.modal-backdrop.show .btn-primary').click()");
    await until("location.pathname.endsWith('login.html')", 10000);
    await wait(400);
  };
  // Cases are numbered in the order they run
  const record = (entry) => {
    entry.id = "TC-" + String(results.length + 1).padStart(2, "0");
    entry.result = entry.pass ? "Pass" : "Fail";
    results.push(entry);
    console.log(`${entry.pass ? "PASS" : "FAIL"}  ${entry.id}  ${entry.feature}: ${entry.input}`);
  };

  const inFuture = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
  const XSS_NOTE = "<img src=x onerror=\"window.__xss=1;alert('XSS')\"> <script>window.__xss=2;alert('XSS')</script>";
  const XSS_NAME = "<script>alert(1)</script>";
  const XSS_DESC = "<svg onload=alert(document.cookie)> <b>bold?</b>";

  // ===================================================== Task 1: input validation
  await go("/index.html#reserve", "window.Validate && document.getElementById('reserveForm')");
  const before = posts.length;
  for (const id of ["rName", "rPhone", "rDate", "rTime"]) await force(`#${id}`, "");
  await submit("#reserveForm");
  await wait(300);
  let shown = await errors("#reserveForm");
  record({
    id: "TC-01", task: "Task 1", feature: "Public reservation form (index.html) – mandatory fields",
    input: "Name, mobile number, date and time left empty; Request my table pressed",
    expected: "Form is not sent; a message appears under each empty required field",
    actual: `${shown.length} messages shown: ${shown.join(" | ")} Requests sent to the server: ${posts.length - before}`,
    pass: shown.length === 4 && posts.length === before,
    screenshot: await shot("reservation-required-fields", "#reserveForm")
  });

  await type("#rName", "A");
  await type("#rPhone", "12345");
  await force("#rDate", inFuture(-3));
  await force("#rTime", "07:30");
  await force("#rParty", "25");
  await force("#rNotes", "x".repeat(170));
  await submit("#reserveForm");
  await wait(300);
  shown = await errors("#reserveForm");
  record({
    id: "TC-02", task: "Task 1", feature: "Public reservation form – lengths, formats and ranges",
    input: "Name \"A\", mobile \"12345\", a date 3 days ago, time 07:30, 25 guests, notes of 170 characters (maxlength bypassed in DevTools)",
    expected: "Each field shows its own message: name too short, mobile format, past date, opening hours, guest range, notes too long",
    actual: `${shown.length} messages shown: ${shown.join(" | ")} Requests sent: ${posts.length - before}`,
    pass: shown.length === 6 && posts.length === before,
    screenshot: await shot("reservation-invalid-formats", "#reserveForm")
  });

  await type("#rName", "   Ayesha    Khan   ");
  await type("#rPhone", " 0321-1234567 ");
  await force("#rDate", inFuture(2));
  await force("#rTime", "19:30");
  await force("#rParty", "4");
  await force("#rNotes", "  " + XSS_NOTE + "  ");
  const typedWithSpaces = await shot("reservation-typed-with-spaces", "#reserveForm");
  await submit("#reserveForm");
  await until("document.getElementById('reserveOk').classList.contains('show') || document.getElementById('reserveErr').classList.contains('show')");
  const okText = await js("document.getElementById('reserveOk').textContent");
  const sentPost = posts.filter((x) => x.url.endsWith("/public/reservations")).pop();
  const sent = sentPost ? JSON.parse(sentPost.body) : {};
  record({
    id: "TC-03", task: "Task 1", feature: "Public reservation form – leading and trailing spaces removed",
    input: "Name \"   Ayesha    Khan   \", mobile \" 0321-1234567 \", valid date, time and guests",
    expected: "Spaces are trimmed (and doubled spaces collapsed) before sending; booking is accepted",
    actual: `Confirmation: "${okText}". Sent to the server: name "${sent.name}", mobile "${sent.phone}", notes start "${String(sent.notes).slice(0, 12)}"`,
    pass: Boolean(okText) && sent.name === "Ayesha Khan" && sent.phone === "03211234567" && !/^\s|\s$/.test(sent.notes),
    screenshot: [typedWithSpaces, await shot("reservation-trimmed-accepted", "#reserveForm")]
  });

  // ---------- Sign in as the Admin (password, then a code from the authenticator secret) ----------
  await go("/login.html", "!document.getElementById('loginBtn').disabled");
  await submit("#loginForm");
  await wait(250);
  shown = await errors("#loginForm");
  record({
    id: "TC-04", task: "Task 1", feature: "Staff sign-in form (login.html) – mandatory fields",
    input: "Username and password left empty; Sign in pressed",
    expected: "Nothing is sent; \"Enter your username.\" and \"Enter your password.\" appear",
    actual: `${shown.length} messages shown: ${shown.join(" | ")}`,
    pass: shown.length === 2,
    screenshot: await shot("login-required-fields", ".auth-form")
  });
  await signInAs(manager, "overview.html");

  // ---------- Staff reservation form (second form for Task 1) ----------
  await go("/reservation.html", "document.getElementById('guestName') && window.App");
  await force("#guestName", "");
  await force("#guestPhone", "");
  await force("#reservationTime", "");
  await force("#partySize", "0");
  await submit("#reservationForm");
  await wait(300);
  shown = await errors("#reservationForm");
  record({
    id: "TC-05", task: "Task 1", feature: "Staff reservation form (reservation.html) – required fields and party size",
    input: "Guest name, mobile and time empty, party size 0",
    expected: "Four messages, one under each field; the reservation is not created",
    actual: `${shown.length} messages shown: ${shown.join(" | ")}`,
    pass: shown.length === 4,
    screenshot: await shot("staff-reservation-invalid", ".dash-grid .panel")
  });
  await type("#guestName", "Bilal Ahmed");
  await type("#guestPhone", "0300 7654321");
  await force("#reservationDate", inFuture(1));
  await force("#reservationTime", "20:00");
  await force("#partySize", "3");
  await submit("#reservationForm");
  await wait(250);
  shown = await errors("#reservationForm");
  record({
    id: "TC-06", task: "Task 1", feature: "Staff reservation form – messages clear when fixed",
    input: "Valid name, mobile \"0300 7654321\", date, time and party size 3",
    expected: "All messages disappear and the reservation is created",
    actual: `${shown.length} messages left; toast: "${await until("document.querySelector('.toast')").then(() => js("document.querySelector('.toast').textContent"))}"`,
    pass: shown.length === 0,
    screenshot: await shot("staff-reservation-valid")
  });

  // ===================================================== Task 2: XSS
  await go("/reservations.html", "window.Store && document.querySelector('main')");
  await wait(800);
  const opened = await js(`(() => { const row = Array.from(document.querySelectorAll("button, tr, li, .res-card, [role=button]")).find((n) => /Ayesha Khan/.test(n.textContent) && n.querySelector && (n.tagName === "BUTTON" || n.querySelector("button"))); if (!row) return false; (row.tagName === "BUTTON" ? row : row.querySelector("button")).click(); return true; })()`);
  await wait(500);
  const notesShown = await js(`(() => { const p = Array.from(document.querySelectorAll("p")).find((n) => n.textContent.indexOf("onerror") !== -1); return p ? { text: p.textContent, childElements: p.children.length } : null; })()`);
  const xssState = await js("({ flag: window.__xss === undefined ? 'not set' : String(window.__xss), injectedImages: document.querySelectorAll('img[src=\"x\"]').length, injectedScripts: Array.from(document.scripts).filter((s) => s.textContent.indexOf('__xss') !== -1).length })");
  record({
    id: "TC-07", task: "Task 2", feature: "Reservation queue (reservations.html) – stored notes shown to staff",
    input: `Guest notes submitted on the public form: ${XSS_NOTE}`,
    expected: "The notes appear as plain text; no image or script element is created, no alert opens, window.__xss stays unset",
    actual: notesShown
      ? `Shown as text: "${notesShown.text}" (child elements inside the paragraph: ${notesShown.childElements}). window.__xss: ${xssState.flag}; injected <img>: ${xssState.injectedImages}; injected <script>: ${xssState.injectedScripts}; alerts opened: ${dialogs.length}`
      : `Reservation details could not be opened (${opened})`,
    pass: Boolean(notesShown) && notesShown.childElements === 0 && xssState.flag === "not set" && xssState.injectedImages === 0 && xssState.injectedScripts === 0 && dialogs.length === 0,
    screenshot: await shot("xss-reservation-notes-as-text")
  });

  const guard = await js(`(() => {
    const out = {};
    try { document.createElement("div").innerHTML = "<img src=x onerror=alert(1)>"; out.innerHTML = "allowed"; } catch (e) { out.innerHTML = e.name + ": " + e.message.split(".")[0]; }
    out.href = CMS.h("a", { href: "javascript:alert(1)" }).getAttribute("href");
    out.hrefTab = CMS.h("a", { href: "java\\tscript:alert(1)" }).getAttribute("href");
    out.handler = CMS.h("button", { onclick: "alert(1)" }).getAttribute("onclick");
    return out;
  })()`);
  record({
    id: "TC-09", task: "Task 2", feature: "Unsafe DOM APIs are refused by the browser (Trusted Types) and by CMS.h",
    input: "From the page: element.innerHTML = '<img src=x onerror=alert(1)>'; CMS.h('a', { href: 'javascript:alert(1)' }); CMS.h('button', { onclick: 'alert(1)' })",
    expected: "innerHTML with a plain string throws; javascript: links are replaced; a string handler is ignored",
    actual: `innerHTML: ${guard.innerHTML}; href became "${guard.href}" (with a hidden tab: "${guard.hrefTab}"); onclick attribute: ${guard.handler === null ? "not set" : guard.handler}; alerts opened: ${dialogs.length}`,
    pass: guard.innerHTML !== "allowed" && guard.href === "about:blank#blocked" && guard.hrefTab === "about:blank#blocked" && guard.handler === null && dialogs.length === 0,
    screenshot: null
  });

  // ===================================================== Task 5: password strength
  await go("/account.html", "window.App && document.getElementById('newPassword')");
  const strengthCases = [
    ["TC-18", "abc", "Weak"],
    ["TC-19", "password1", "Weak"],
    ["TC-20", "Coffee2024", "Moderate"],
    ["TC-21", "Brew-House-58-Lantern!", "Strong"]
  ];
  for (const [id, pw, level] of strengthCases) {
    await type("#newPassword", pw);
    await wait(150);
    const s = await js("({ level: document.querySelector('#newPassword-strength .pw-strength-level').textContent, score: document.querySelector('#newPassword-strength .pw-strength-score').textContent.trim(), message: document.querySelector('#newPassword-strength .pw-strength-msg').textContent, direct: checkPasswordStrength(document.getElementById('newPassword').value) })");
    record({
      id, task: "Task 5", feature: "Password strength checker (account.html, Change password)",
      input: `"${pw}" typed into New password`,
      expected: `${level}, shown below the field as the user types`,
      actual: `Shown: ${s.level} ${s.score} – "${s.message}". checkPasswordStrength() returned ${s.direct.level}, score ${s.direct.score}`,
      pass: s.level === level && s.direct.level === level,
      screenshot: await shot(`strength-${level.toLowerCase()}-${pw.length}-characters`, "#passwordForm")
    });
  }
  await type("#newPassword", "");
  const hidden = await js("document.getElementById('newPassword-strength').hidden");
  record({
    id: "TC-22", task: "Task 5", feature: "Password strength checker – cleared field",
    input: "New password emptied",
    expected: "The strength box is hidden again",
    actual: hidden ? "Hidden" : "Still visible",
    pass: hidden,
    screenshot: null
  });
  // The change-password form also validates before sending
  await type("#currentPassword", "");
  await type("#newPassword", "short");
  await submit("#passwordForm");
  await wait(250);
  shown = await errors("#passwordForm");
  record({
    id: "TC-23", task: "Task 1", feature: "Change password form (account.html) – required and minimum length",
    input: "Current password empty, new password \"short\"",
    expected: "Two messages; the request is not sent",
    actual: `${shown.length} messages: ${shown.join(" | ")}`,
    pass: shown.length === 2,
    screenshot: await shot("password-form-invalid", "#passwordForm")
  });

  // ===================================================== Task 4: sensitive information
  const storage = await js(`(() => {
    const dump = (s) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)).map((k) => [k, s.getItem(k)]));
    return { session: dump(sessionStorage), local: dump(localStorage), cookie: document.cookie };
  })()`);
  const everything = JSON.stringify(storage);
  const leaked = ["Brew-House-58-Lantern", "password", "csrf", "token", "secret", "jwt", "03211234567"].filter((w) => everything.toLowerCase().indexOf(w.toLowerCase()) !== -1);
  record({
    id: "TC-24", task: "Task 4", feature: "Browser storage while signed in",
    input: "Developer tools → Application: sessionStorage, localStorage and document.cookie read after signing in and using the app",
    expected: "No password, token, code or customer number; localStorage empty; the session cookie is invisible to scripts (HttpOnly)",
    actual: `sessionStorage: ${JSON.stringify(storage.session)}; localStorage: ${JSON.stringify(storage.local)}; document.cookie: "${storage.cookie}"; sensitive words found: ${leaked.length ? leaked.join(", ") : "none"}`,
    pass: leaked.length === 0 && Object.keys(storage.local).length === 0 && storage.cookie === "" && Object.keys(storage.session).every((k) => ["cms_session", "cms_flash"].includes(k)),
    screenshot: null
  });

  await js("localStorage.setItem('password', 'Brew-House-58-Lantern'); sessionStorage.setItem('authToken', 'abc.def.ghi'); true");
  await go("/overview.html", "window.App && document.querySelector('[data-signout]')");
  const swept = await js("({ local: localStorage.length, token: sessionStorage.getItem('authToken'), keys: Object.keys(sessionStorage) })");
  record({
    id: "TC-25", task: "Task 4", feature: "Unneeded items in browser storage are removed",
    input: "localStorage.password and sessionStorage.authToken planted from the console, then the next page opened",
    expected: "Both are removed on page load; only cms_session (name, username, role, sign-in time) remains",
    actual: `localStorage items: ${swept.local}; authToken: ${swept.token === null ? "removed" : swept.token}; sessionStorage keys: ${swept.keys.join(", ")}`,
    pass: swept.local === 0 && swept.token === null && swept.keys.every((k) => ["cms_session", "cms_flash"].includes(k)),
    screenshot: null
  });

  const scripts = await js("Array.from(document.scripts).map((s) => s.src).filter(Boolean)");
  const bodies = await Promise.all(scripts.map((src) => fetch(src).then((r) => r.text())));
  const secretPatterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/, /AKIA[0-9A-Z]{16}/, /\b(?:JWT|DATA|AUDIT|BLIND_INDEX|GATEWAY)_(?:KEYS?|SECRET)\s*[:=]/, /mongodb(?:\+srv)?:\/\/[^\s"']+:[^\s"']+@/];
  const hits = bodies.flatMap((b, i) => secretPatterns.filter((p) => p.test(b)).map((p) => `${scripts[i]} ${p}`));
  record({
    id: "TC-26", task: "Task 4", feature: "No secret keys or credentials in frontend JavaScript",
    input: `${scripts.length} scripts loaded by the Manager overview page scanned for private keys, API keys, server secrets and database passwords`,
    expected: "None found",
    actual: hits.length ? hits.join("; ") : `None found in ${scripts.length} scripts`,
    pass: hits.length === 0,
    screenshot: null
  });

  await signOut();
  const afterLogout = await js("({ keys: Object.keys(sessionStorage), local: localStorage.length, cookie: document.cookie, alert: document.getElementById('formAlert').textContent })");
  const me = await js("fetch('/api/v1/auth/me', { credentials: 'same-origin' }).then((r) => r.status)");
  await cdp.send("Page.navigate", { url: `${ORIGIN}/overview.html` });
  await wait(1500);
  const backTo = await js("location.pathname");
  record({
    id: "TC-27", task: "Task 4", feature: "Sign out clears the temporary state",
    input: "Sign out pressed and confirmed, then the overview page opened again",
    expected: "cms_session removed, nothing in localStorage, the server session ends (401), and the protected page sends the user back to sign in",
    actual: `sessionStorage keys after sign-out: ${afterLogout.keys.length ? afterLogout.keys.join(", ") : "none"}; localStorage items: ${afterLogout.local}; /auth/me now returns ${me}; opening overview.html ended on ${backTo}; message: "${afterLogout.alert}"`,
    pass: !afterLogout.keys.includes("cms_session") && afterLogout.local === 0 && me === 401 && backTo.endsWith("login.html"),
    screenshot: await shot("signed-out")
  });

  // ---------- Admin: menu items (Task 2, second component) and the photo picker (Task 3) ----------
  await signInAs(admin, "overview.html");
  // Menu item with markup in its name and description, then the public menu that customers see
  await go("/menu.html", "window.Store && document.getElementById('addItem')");
  await click("#addItem");
  await wait(300);
  await type("#fName", XSS_NAME);
  await type("#fCat", "Coffee");
  await force("#fPrice", "450");
  await type("#fDesc", XSS_DESC);
  await submit("#itemForm");
  await until("!document.getElementById('itemModal').classList.contains('show')");
  await go("/index.html#menu", "document.querySelectorAll('#publicMenu .menu-card').length > 0");
  const card = await js(`(() => { const c = Array.from(document.querySelectorAll("#publicMenu .menu-card")).find((n) => n.textContent.indexOf("alert(1)") !== -1); if (!c) return null; c.id = "xssCard"; return { title: c.querySelector("h3").textContent, desc: c.querySelector("p").textContent, svg: c.querySelectorAll("svg").length, bold: c.querySelectorAll("b").length, scripts: c.querySelectorAll("script").length }; })()`);
  record({
    id: "TC-08", task: "Task 2", feature: "Public menu (index.html) – item name and description entered by staff",
    input: `Item name ${XSS_NAME}; description ${XSS_DESC}`,
    expected: "Both are displayed literally as text on the public menu; nothing executes",
    actual: card ? `Title shown: "${card.title}"; description shown: "${card.desc}"; <script>: ${card.scripts}, <svg>: ${card.svg}, <b>: ${card.bold}; alerts opened: ${dialogs.length}` : "Card not found",
    pass: Boolean(card) && card.title === XSS_NAME && card.scripts === 0 && card.svg === 0 && card.bold === 0 && dialogs.length === 0,
    screenshot: await shot("xss-public-menu-as-text", "#xssCard")
  });

  // ===================================================== Task 3: file selection
  await go("/menu.html", "window.Store && document.getElementById('addItem')");
  await click("#addItem");
  await wait(300);
  const photoMessage = () => js("({ error: (document.getElementById('fPhoto-error') || {}).textContent || '', status: document.getElementById('fPhoto-status').textContent, kept: document.getElementById('fPhoto').files.length })");
  const fileCases = [
    ["TC-10", "valid", "flat-white.png (64×64 PNG, " + png.length + " bytes)", "Accepted: \"Ready to upload\" with the name and size", (m) => m.status.startsWith("Ready to upload") && m.kept === 1 && !m.error],
    ["TC-11", "exe", "setup.exe (a program)", "Refused: not an allowed file type; the selection is cleared", (m) => /not an allowed file type/.test(m.error) && m.kept === 0],
    ["TC-12", "pdf", "menu-card.pdf (a document)", "Refused: not an allowed file type", (m) => /not an allowed file type/.test(m.error) && m.kept === 0],
    ["TC-13", "big", "large-photo.png (3 MB)", "Refused: larger than the 2 MB limit", (m) => /largest file allowed is 2\.00 MB/.test(m.error) && m.kept === 0],
    ["TC-14", "fake", "not-really.png (a PHP script renamed to .png)", "Refused: contents are not a PNG image", (m) => /contents are not a PNG image/.test(m.error) && m.kept === 0],
    ["TC-15", "double", "photo.php.png (hidden second extension)", "Refused: not an allowed file type", (m) => /not an allowed file type/.test(m.error) && m.kept === 0],
    ["TC-16", "svg", "logo.svg (an SVG with an onload script)", "Refused: SVG is not allowed", (m) => /not an allowed file type/.test(m.error) && m.kept === 0]
  ];
  for (const [id, key, input, expected, ok] of fileCases) {
    await setFile("#fPhoto", FILES[key]);
    const m = await photoMessage();
    record({
      id, task: "Task 3", feature: "Menu item photo (menu.html)",
      input, expected,
      actual: m.error ? `Message: "${m.error}"; files kept in the picker: ${m.kept}` : `Status: "${m.status}"; files kept: ${m.kept}`,
      pass: ok(m),
      screenshot: await shot(`file-${key}`, "#itemForm .modal-body")
    });
  }
  // A valid photo really uploads, and the server rebuilds it
  await setFile("#fPhoto", FILES.valid);
  await type("#fName", "Flat White Special");
  await type("#fCat", "Coffee");
  await force("#fPrice", "560");
  await type("#fDesc", "Velvety milk, double shot.");
  await submit("#itemForm");
  await until("!document.getElementById('itemModal').classList.contains('show')", 15000);
  await wait(800);
  const thumb = await js("Array.from(document.querySelectorAll('#menuBody tr')).some((r) => r.textContent.indexOf('Flat White Special') !== -1 && r.querySelector('img.menu-thumb'))");
  record({
    id: "TC-17", task: "Task 3", feature: "Menu item photo – permitted file is uploaded",
    input: "flat-white.png selected and the item saved",
    expected: "Item is saved and its photo thumbnail appears in the menu list",
    actual: thumb ? "Saved; thumbnail shown in the list" : "No thumbnail found",
    pass: thumb,
    screenshot: await shot("file-valid-uploaded", "#menuBody")
  });

  await signOut();

  // The setup (invitation / reset) page uses the same checker
  await go("/setup.html", "document.getElementById('newPassword')");
  await type("#newPassword", "Coffee2024");
  await wait(150);
  const setupLevel = await js("document.querySelector('#newPassword-strength .pw-strength-level').textContent");
  record({
    id: "TC-28", task: "Task 5", feature: "Password strength checker on the invitation / reset page (setup.html)",
    input: "\"Coffee2024\" typed into New password",
    expected: "Moderate shown below the field",
    actual: `Shown: ${setupLevel}`,
    pass: setupLevel === "Moderate",
    screenshot: await shot("setup-strength-moderate", ".auth-form")
  });

  fs.writeFileSync(path.join(OUT, "test-results.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    browser: path.basename(findBrowser()),
    note: "Produced by scripts/activity5-evidence.js against a throwaway copy of CafeMS. Actual results are read from the page.",
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    cases: results
  }, null, 2) + "\n");
  console.log(`\n${results.filter((r) => r.pass).length} of ${results.length} passed. Evidence in docs/activity-5/`);

  cdp.close();
  chrome.kill();
  server.close();
  await stop();
  fs.rmSync(files, { recursive: true, force: true });
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still closing */ } process.exit(results.every((r) => r.pass) ? 0 : 1); }, 1000);
})().catch((error) => { console.error("EVIDENCE RUN FAILED:", error); process.exit(1); });
