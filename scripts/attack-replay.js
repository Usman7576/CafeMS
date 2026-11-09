// Usage: NODE_EXTRA_CA_CERTS=<caddy root.crt> node scripts/attack-replay.js <new Admin's setup link> [--write]
//
// Replays all 30 attacks in docs/security/BURP-TEST-SCRIPT.md against a running throwaway production stack,
// over real HTTPS, and checks that each is refused. To send the same requests through Burp Suite so that
// they appear in its HTTP history, also set NODE_USE_ENV_PROXY=1 and HTTPS_PROXY=http://127.0.0.1:8080.
//
// It creates accounts and alters records, so never point it at a live site.
require("dotenv").config({ path: "deploy/.env", quiet: true });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const totp = require("../server/lib/totp");
const { callbackSignature } = require("../server/services/gateway");

const [link] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!link) { console.error("Give a new Admin's setup link."); process.exit(1); }
const ORIGIN = new URL(link).origin;
const API = "/api/v1";
const PASSWORD = `Replay-${crypto.randomBytes(9).toString("base64url")}-7a!`;
const key = () => crypto.randomBytes(16).toString("hex");
const results = [];

function record(no, attack, expected, ok, actual) {
  results.push({ no, attack, expected, ok: Boolean(ok), actual: String(actual) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(no).padStart(2)}  ${attack}  (${actual})`);
}

function client() {
  const jar = {};
  const c = {
    jar, csrf: null,
    async call(method, url, body, extra = {}) {
      const headers = { Origin: ORIGIN, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...extra };
      for (const name of Object.keys(headers)) if (headers[name] === null) delete headers[name];
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      if (c.csrf && method !== "GET" && extra["X-CSRF-Token"] !== null) headers["X-CSRF-Token"] = c.csrf;
      const payload = body === undefined || Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
      const res = await fetch(ORIGIN + url, { method, headers, body: payload, redirect: "manual" });
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const at = pair.indexOf("=");
        const value = pair.slice(at + 1);
        if (value) jar[pair.slice(0, at)] = value; else delete jar[pair.slice(0, at)];
      }
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    get: (url, extra) => c.call("GET", API + url, undefined, extra),
    post: (url, body, extra) => c.call("POST", API + url, body, extra),
    put: (url, body, extra) => c.call("PUT", API + url, body, extra),
    async loadCsrf() { c.csrf = (await c.get("/auth/me")).json.csrfToken; }
  };
  return c;
}

const code = (r) => (r.json && r.json.error ? r.json.error.code : "");
const shown = (r) => `${r.status}${code(r) ? ` ${code(r)}` : ""}`;

// Takes a code from a step not yet used: each 30-second code works only once
async function freshCode(secret) {
  await new Promise((resolve) => { setTimeout(resolve, 30000 - (Date.now() % 30000) + 200); });
  return totp.generate(secret);
}

async function enrol(token, label) {
  const c = client();
  const set = await c.post("/auth/setup", { token, password: PASSWORD });
  if (set.status !== 200) throw new Error(`Setup failed for ${label}: ${set.status}`);
  const start = await c.post("/auth/mfa/enroll/start", {});
  const confirm = await c.post("/auth/mfa/enroll/confirm", { code: totp.generate(start.json.manualKey) });
  if (confirm.status !== 200) throw new Error(`Enrolment failed for ${label}: ${confirm.status}`);
  await c.loadCsrf();
  c.secret = start.json.manualKey;
  c.username = confirm.json.username;
  return c;
}

function database(script) {
  return execFileSync("docker", ["exec", "cafems-prod-mongo-1", "sh", "-c",
    "mongosh --quiet -u \"$MONGO_INITDB_ROOT_USERNAME\" -p \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin cafems --eval \"$1\"", "sh", script], { encoding: "utf8" });
}

(async () => {
  const admin = await enrol(link.split("#token=")[1], "Admin");
  const up = await admin.post("/auth/step-up", { code: await freshCode(admin.secret) });
  if (up.status !== 204) throw new Error(`Step-up failed: ${up.status}`);

  const invite = async (username, role) => {
    const res = await admin.post("/users/invitations", { username, name: `Replay ${role}`, role });
    if (res.status !== 201) throw new Error(`Invitation failed: ${res.status} ${res.text}`);
    return enrol(res.json.setupUrl.split("#token=")[1], username);
  };
  const waiterA = await invite("replay.waitera", "Waiter");
  const waiterB = await invite("replay.waiterb", "Waiter");
  const kitchen = await invite("replay.kitchen", "Kitchen");
  const cashier = await invite("replay.cashier", "Cashier");
  const manager = await invite("replay.manager", "Manager");
  const locked = await invite("replay.locked", "Waiter");
  const replay = await invite("replay.reuse", "Waiter");

  const item = (await admin.post("/menu", { name: "Replay Coffee", cat: "Coffee", price: 20000, desc: "Test item" })).json;
  const placeOrder = (client_, table, qty = 1) => client_.post("/orders", { table, lines: [{ id: item.id, qty }], notes: "" }, { "Idempotency-Key": key() });
  async function readyForBill(table) {
    const order = await placeOrder(waiterA, table);
    if (order.status !== 201) throw new Error(`Order failed: ${order.status} ${order.text}`);
    await kitchen.post(`/kitchen/tickets/${order.json.id}/status`, { status: "Preparing" });
    await kitchen.post(`/kitchen/tickets/${order.json.id}/status`, { status: "Ready" });
    await waiterA.post(`/orders/${order.json.id}/serve`, {});
    await waiterA.post(`/tables/${table}/request-bill`, {});
    return order.json;
  }
  const pay = async (table, method) => {
    const res = await cashier.post(`/billing/tables/${table}/pay`, { method, tendered: method === "Cash" ? 50000 : undefined }, { "Idempotency-Key": key() });
    if (res.status !== 201 && res.status !== 200 && res.status !== 202) throw new Error(`Payment failed: ${res.status} ${res.text}`);
    return res.json;
  };

  // ---------- Authentication and sessions ----------
  {
    const c = client();
    const statuses = [];
    for (const password of ["Wrong-Password-1!", "Wrong-Password-2!", "Wrong-Password-3!", PASSWORD]) statuses.push((await c.post("/auth/login", { username: locked.username, password })).status);
    record(1, "Three wrong passwords, then the right one", "401 every time", statuses.every((s) => s === 401), statuses.join(", "));
  }
  {
    const original = admin.jar["__Host-cms_session"];
    const c = client();
    c.jar["__Host-cms_session"] = `${original.slice(0, -2)}${original.endsWith("A") ? "BB" : "AA"}`;
    const r = await c.get("/auth/me");
    record(3, "Change the session cookie's value", "401", r.status === 401, shown(r));
  }
  {
    const [, payload] = admin.jar["__Host-cms_session"].split(".");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const c = client();
    c.jar["__Host-cms_session"] = `${header}.${payload}.`;
    const r = await c.get("/auth/me");
    record(4, "Token with alg none and no signature", "401", r.status === 401, shown(r));
  }
  {
    const old = { ...replay.jar };
    await replay.post("/auth/logout", {});
    const c = client();
    Object.assign(c.jar, old);
    const r = await c.get("/auth/me");
    record(5, "Replay a request after signing out", "401", r.status === 401, shown(r));
  }
  {
    const c = client();
    await c.post("/auth/login", { username: replay.username, password: PASSWORD });
    const r = await c.get("/snapshot");
    record(6, "Password only, skipping the authenticator step", "401", r.status === 401, shown(r));
    const used = await freshCode(replay.secret);
    await c.post("/auth/mfa/verify", { code: used });
    const again = client();
    await again.post("/auth/login", { username: replay.username, password: PASSWORD });
    const r2 = await again.post("/auth/mfa/verify", { code: used });
    record(7, "Reuse an authenticator code", "401", r2.status === 401, shown(r2));
  }

  // ---------- Authorization ----------
  {
    const a = [await waiterA.get("/users"), await waiterA.get("/audit"), await waiterA.get("/reports/sales")];
    const entries = (await admin.get("/audit?limit=200")).json.entries;
    const logged = entries.some((e) => e.action === "Access denied" && e.actor === waiterA.username);
    record(8, "Waiter opens users, audit log and sales report", "403, and an audit entry", a.every((r) => r.status === 403) && logged, `${a.map((r) => r.status).join(", ")}; logged: ${logged}`);
  }
  await readyForBill(1);
  {
    const r = await waiterA.post("/billing/tables/1/pay", { method: "Cash", tendered: 50000 }, { "Idempotency-Key": key() });
    record(9, "Waiter takes a payment", "403", r.status === 403, shown(r));
  }
  {
    const order = await placeOrder(waiterA, 5);
    const r = await waiterB.put(`/orders/${order.json.id}`, { version: 0, lines: [{ id: item.id, qty: 2 }], notes: "" });
    record(10, "Waiter B edits Waiter A's order", "404", r.status === 404, shown(r));
    await waiterA.post(`/orders/${order.json.id}/cancel`, {});
  }
  const oldBill = await pay(1, "Cash");
  database(`db.bills.updateOne({_id:'${oldBill.no}'},{$set:{createdAt:new Date(Date.now()-172800000)}})`);
  {
    const r = await cashier.get(`/bills/${oldBill.no}`);
    record(11, "Cashier opens an older bill", "404", r.status === 404, shown(r));
    const snap = await kitchen.get("/snapshot");
    const leak = /price|phone/i.test(snap.text);
    record(12, "Kitchen snapshot searched for prices and phone numbers", "Neither appears", snap.status === 200 && !leak, `${snap.status}; found: ${leak}`);
  }
  await readyForBill(2);
  const largeBill = await pay(2, "Cash");
  {
    const r = await manager.post(`/bills/${largeBill.no}/refund`, { reason: "Replay test" }, { "Idempotency-Key": key() });
    record(13, "Manager refunds with no recent authenticator code", "403 step_up_required", r.status === 403 && code(r) === "step_up_required", shown(r));
    const stepped = await manager.post("/auth/step-up", { code: await freshCode(manager.secret) });
    if (stepped.status !== 204) throw new Error(`Manager step-up failed: ${stepped.status}`);
    const requested = await manager.post(`/bills/${largeBill.no}/refund`, { reason: "Replay test" }, { "Idempotency-Key": key() });
    const pending = (await manager.get("/approvals")).json.approvals.find((a) => a.type === "refund");
    const r2 = await manager.post(`/approvals/${pending ? pending.id : "aaaaaaaaaaaaaaaaaaaaaaaa"}/approve`, {});
    record(14, "Manager approves their own large refund", "403 same_person", r2.status === 403 && code(r2) === "same_person", `${shown(r2)} (request ${requested.status})`);
  }

  // ---------- Input and business rules ----------
  {
    const a = await waiterA.post("/orders", { table: 6, lines: [{ id: item.id, qty: 1 }], notes: "", total: 1 }, { "Idempotency-Key": key() });
    const b = await waiterA.post("/orders", { table: 6, lines: [{ id: item.id, qty: 1, price: 1 }], notes: "" }, { "Idempotency-Key": key() });
    record(15, "Add total or price to an order", "400", a.status === 400 && b.status === 400, `${a.status}, ${b.status}`);
    const statuses = [];
    for (const qty of [-5, 0, 1.5, 100, "1"]) statuses.push((await waiterA.post("/orders", { table: 6, lines: [{ id: item.id, qty }], notes: "" }, { "Idempotency-Key": key() })).status);
    record(16, "Quantity of -5, 0, 1.5, 100 and \"1\"", "400 each time", statuses.every((s) => s === 400), statuses.join(", "));
    const r = await client().post("/auth/login", { username: { $ne: null }, password: { $ne: null } });
    record(17, "NoSQL operators in the sign-in form", "401", r.status === 401, shown(r));
  }
  await readyForBill(3);
  {
    const before = (await admin.get("/audit?limit=200")).json.entries.filter((e) => e.actor === cashier.username).length;
    const r = await cashier.post("/billing/tables/3/pay", { method: "Cash", tendered: 50000, discountPct: 50 }, { "Idempotency-Key": key() });
    const after = (await admin.get("/audit?limit=200")).json.entries.filter((e) => e.actor === cashier.username).length;
    record(18, "Cashier applies a 50% discount", "403, and an audit entry", r.status === 403 && after > before, `${shown(r)}; entries ${before} to ${after}`);
  }
  {
    const repeat = key();
    const body = { table: 7, lines: [{ id: item.id, qty: 1 }], notes: "" };
    const first = await waiterA.post("/orders", body, { "Idempotency-Key": repeat });
    const second = await waiterA.post("/orders", body, { "Idempotency-Key": repeat });
    const mine = (await waiterA.get("/orders")).json.orders.filter((o) => o.table === 7);
    record(19, "Resend the same Idempotency-Key and body", "The first result, and no second record", first.status === 201 && second.json.id === first.json.id && mine.length === 1, `${first.status}, ${second.status}; orders: ${mine.length}`);
    const r = await waiterA.post("/orders", { ...body, table: 8 }, { "Idempotency-Key": repeat });
    record(20, "Resend that key with a different body", "422", r.status === 422, shown(r));
  }
  {
    const payload = "<img src=x onerror=alert(1)>";
    const when = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const made = await waiterA.post("/reservations", { name: payload, phone: "03001234567", date: when, time: "12:00", party: 2 }, { "Idempotency-Key": key() });
    const page = await client().call("GET", "/reservations.html");
    const csp = page.headers.get("content-security-policy") || "";
    const safe = made.status === 201 && made.json.name === payload && (made.headers.get("content-type") || "").includes("json") && !/script-src[^;]*unsafe-inline/.test(csp);
    record(21, "Script in a guest's name", "Stored as plain text, and the page policy forbids inline script", safe, `${made.status}; JSON response; inline script forbidden`);
  }

  // ---------- CSRF and headers ----------
  {
    const noToken = await waiterA.post("/tables/4/request-bill", {}, { "X-CSRF-Token": null });
    record(22, "Remove the CSRF token", "403", noToken.status === 403, shown(noToken));
    const badOrigin = await waiterA.post("/tables/4/request-bill", {}, { Origin: "https://evil.example" });
    record(23, "Change Origin to another site", "403", badOrigin.status === 403, shown(badOrigin));
    const noOrigin = await waiterA.post("/tables/4/request-bill", {}, { Origin: null });
    record(24, "Remove the Origin header", "403", noOrigin.status === 403, shown(noOrigin));
    const page = await client().call("GET", "/login.html");
    const csp = page.headers.get("content-security-policy") || "";
    const ok = csp && !/unsafe-inline/.test(csp) && page.headers.get("x-frame-options") === "DENY" && page.headers.get("x-content-type-options") === "nosniff";
    record(25, "Check response headers", "CSP with no unsafe-inline, DENY, nosniff", ok, `frame ${page.headers.get("x-frame-options")}; ${page.headers.get("x-content-type-options")}`);
  }

  // ---------- File upload ----------
  {
    const send = (type, body) => admin.put(`/menu/${item.id}/photo`, body, { "Content-Type": type });
    const a = await send("image/png", Buffer.from("<html><script>alert(1)</script></html>"));
    const logged = (await admin.get("/audit?limit=50")).json.entries.some((e) => e.action === "Upload refused");
    record(26, "HTML uploaded as a PNG", "415, and recorded", a.status === 415 && logged, `${shown(a)}; logged: ${logged}`);
    const b = await send("image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"));
    record(27, "SVG upload", "415", b.status === 415, shown(b));
    const c = await send("image/png", Buffer.alloc(2 * 1024 * 1024 + 2048, 1));
    record(28, "Upload over 2 MB", "413", c.status === 413, shown(c));
  }

  // ---------- Payment callback ----------
  {
    const body = { reference: largeBill.no, amount: largeBill.total, status: "declined", gatewayRef: "REPLAY-1" };
    const forged = await client().call("POST", `${API}/payments/callback`, body, { Origin: null });
    const logged = (await admin.get("/audit?limit=50")).json.entries.some((e) => e.action === "Gateway callback refused");
    record(29, "Payment callback with no signature", "401, and recorded", forged.status === 401 && logged, `${shown(forged)}; logged: ${logged}`);
    database(`db.bills.updateOne({_id:'${largeBill.no}'},{$set:{status:'Pending Payment'}})`);
    const timestamp = String(Date.now());
    const headers = { Origin: null, "X-Gateway-Timestamp": timestamp, "X-Gateway-Signature": callbackSignature(Buffer.from(process.env.GATEWAY_SECRET, "base64"), timestamp, body) };
    const first = await client().call("POST", `${API}/payments/callback`, body, headers);
    database(`db.bills.updateOne({_id:'${largeBill.no}'},{$set:{status:'Pending Payment'}})`);
    const second = await client().call("POST", `${API}/payments/callback`, body, headers);
    record(30, "Correct signature sent twice", "204, then 409", first.status === 204 && second.status === 409, `${shown(first)}, ${shown(second)}`);
  }

  // Last, because it uses up this address's sign-in allowance
  {
    const statuses = [];
    for (let i = 0; i < 25; i += 1) statuses.push((await client().post("/auth/login", { username: `nobody${i}`, password: "Wrong-Password-1!" })).status);
    const refused = statuses.filter((s) => s === 429).length;
    record(2, "25 wrong sign-ins for different usernames", "429 after about 20", refused >= 3 && statuses[0] === 401, `${statuses.filter((s) => s === 401).length} x 401, then ${refused} x 429`);
  }

  results.sort((a, b) => a.no - b.no);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} attacks refused as expected.`);
  if (process.argv.includes("--write")) {
    const viaBurp = process.env.BURP_USED === "1";
    const lines = [
      "# Attack replay results", "",
      `**${results.length - failed} of ${results.length} attacks from the Burp Suite test script behaved as expected against the running production stack.** Generated by \`scripts/attack-replay.js\` on ${new Date().toISOString().slice(0, 10)}, over real HTTPS through Caddy, against the encrypted two-process stack.`, "",
      viaBurp ? "These requests were sent through Burp Suite's proxy." : "**This replay is automated and did not go through Burp Suite.** It sends the same requests as [BURP-TEST-SCRIPT.md](BURP-TEST-SCRIPT.md), but it only checks the listed attacks; a person using Burp may try things that are not listed.", "",
      "| # | Attack | Expected | Result |", "| --- | --- | --- | --- |",
      // Only the script's own text goes into the file, never anything the server sent back
      ...results.map((r) => `| ${r.no} | ${r.attack} | ${r.expected} | ${r.ok ? "Pass" : "**Fail**"} |`), ""
    ];
    fs.writeFileSync(path.join(__dirname, "..", "docs", "security", "ATTACK-REPLAY-RESULTS.md"), lines.join("\n"));
  }
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error(`The replay could not finish: ${error.message}`);
  process.exit(1);
});
