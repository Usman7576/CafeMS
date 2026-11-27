// Project Activity 6: backend, JWT authentication and authorization evidence.
// Starts a throwaway copy of CafeMS on an in-memory MongoDB (nothing touches real data), sends the
// same HTTP requests the browser pages send, and records what the server actually answered:
//   docs/activity-6/test-results.json   every case: request, expected result, actual result
//   docs/activity-6/TEST-RESULTS.md     the same, as tables for the report
//   docs/activity-6/API-ENDPOINTS.md    every backend route with its guard, generated from the router
// The actual results come from the live responses, never written in by hand. The script exits
// with code 1 if any case does not match its expected result. tests/activity6.test.js runs it too.
//
// Run: node scripts/activity6-evidence.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "activity-6");
const h = require(path.join(ROOT, "tests", "helpers.js"));
const { seedCatalog } = require(path.join(ROOT, "scripts", "seed-data.js"));
const { SESSION_COOKIE } = require(path.join(ROOT, "server", "services", "sessions"));
const { PERMISSIONS } = require(path.join(ROOT, "server", "lib", "permissions"));

const API = "/api/v1";
const PHONE = "03211234567";
const idem = () => ({ headers: { "Idempotency-Key": crypto.randomBytes(16).toString("hex") } });
const futureDate = () => new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

// Shows the start and end of a token only; the full value is a credential
const shorten = (token) => (typeof token === "string" && token.length > 40 ? `${token.slice(0, 24)}…${token.slice(-8)}` : token);

// Only what a reader needs from a response; never cookies or full tokens
function summary(res) {
  const body = res.body && Object.keys(res.body).length ? res.body : undefined;
  return { status: res.status, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body, (k, v) => (k === "csrfToken" ? "(hidden)" : v))) };
}

async function runCases() {
  const ctx = await h.startDb();
  const results = [];
  try {
    const { db } = ctx;
    await seedCatalog(db);
    const { app, config } = h.buildApp(db);
    const as = async (role, extra) => h.signIn(app, db, await h.createUser(db, config, { role, ...extra }));

    function record(task, id, title, request, expected, actual, pass, extra = {}) {
      results.push({ task, id, title, request, expected, actual, pass: Boolean(pass), ...extra });
    }

    // ---------- Task 4 / Task 6.1: login and JWT generation ----------
    const waiterUser = await h.createUser(db, config, { role: "Waiter", username: "demo.waiter" });
    const stored = await db.collection("users").findOne({ username: waiterUser.username });
    record("Task 4.3", "A6-01", "Password is stored as an Argon2id hash, not plaintext",
      "Read users.passwordHash for demo.waiter from MongoDB",
      "Starts with $argon2id$ and does not contain the password",
      { passwordHash: shorten(stored.passwordHash) },
      stored.passwordHash.startsWith("$argon2id$") && !stored.passwordHash.includes(waiterUser.password));

    const wrong = h.browser(app);
    const bad = await wrong.post(`${API}/auth/login`, { username: waiterUser.username, password: "Wrong-Password-1" });
    record("Task 4.2", "A6-02", "Wrong password is refused by the server",
      `POST ${API}/auth/login {username: "demo.waiter", password: "Wrong-Password-1"}`,
      "401 with a generic message that does not say which part was wrong",
      summary(bad), bad.status === 401 && !wrong.jar[SESSION_COOKIE]);

    const waiter = h.browser(app);
    const step1 = await waiter.post(`${API}/auth/login`, { username: waiterUser.username, password: waiterUser.password });
    const step2 = await waiter.post(`${API}/auth/mfa/verify`, { code: await h.freshCode(db, waiterUser) });
    const token = waiter.jar[SESSION_COOKIE];
    const decoded = token && jwt.decode(token, { complete: true });
    const verified = token && jwt.verify(token, config.jwt.keys.get(decoded.header.kid), { algorithms: ["HS256"] });
    record("Task 4.1, 4.4 / Task 6.1", "A6-03", "Successful login generates a signed JWT",
      `POST ${API}/auth/login (correct password), then POST ${API}/auth/mfa/verify (authenticator code)`,
      "200, 200, and a signed HS256 JWT set in the HttpOnly __Host-cms_session cookie",
      { loginStatus: step1.status, mfaStatus: step2.status, cookie: SESSION_COOKIE, token: shorten(token), header: decoded && decoded.header, claims: decoded && { sub: decoded.payload.sub, iss: decoded.payload.iss, aud: decoded.payload.aud, iat: decoded.payload.iat, exp: decoded.payload.exp, jti: "(random id)" } },
      step1.status === 200 && step2.status === 200 && decoded && decoded.header.alg === "HS256" && verified.sub === waiterUser.username);
    await waiter.loadCsrf();

    // ---------- Task 6.2: protected endpoint with a valid token ----------
    const me = await waiter.get(`${API}/auth/me`);
    record("Task 4.5 / Task 6.2", "A6-04", "Protected endpoint accepts a valid token",
      `GET ${API}/auth/me with the session cookie`, "200 with the signed-in user and role",
      summary(me), me.status === 200 && me.body.username === waiterUser.username && me.body.role === "Waiter");

    // ---------- Task 6.3: missing, invalid and modified tokens ----------
    const withToken = (value) => { const c = h.browser(app); if (value !== undefined) c.jar[SESSION_COOKIE] = value; return c.get(`${API}/reservations`); };
    const [head, payload, sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...decoded.payload, sub: "farah.admin" })).toString("base64url");
    const flippedSig = sig.slice(0, -2) + (sig.slice(-2) === "AA" ? "BB" : "AA");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: decoded.header.kid })).toString("base64url");
    const tokenCases = [
      ["A6-05", "No token at all", undefined],
      ["A6-06", "Random text instead of a token", "not-a-jwt"],
      ["A6-07", "Payload modified (sub changed to another user), signature kept", `${head}.${forgedPayload}.${sig}`],
      ["A6-08", "Signature modified", `${head}.${payload}.${flippedSig}`],
      ["A6-09", "Algorithm changed to \"none\" with the signature removed", `${noneHeader}.${payload}.`],
      ["A6-10", "Signed with a different secret key", jwt.sign({ jti: decoded.payload.jti }, crypto.randomBytes(32), { algorithm: "HS256", keyid: decoded.header.kid, subject: waiterUser.username, issuer: "cafems", audience: "cafems-staff" })],
      ["A6-11", "Correct key but already expired", jwt.sign({ jti: decoded.payload.jti, exp: Math.floor(Date.now() / 1000) - 60 }, config.jwt.keys.get(decoded.header.kid), { algorithm: "HS256", keyid: decoded.header.kid, subject: waiterUser.username, issuer: "cafems", audience: "cafems-staff" })]
    ];
    for (const [id, title, value] of tokenCases) {
      const res = await withToken(value);
      record("Task 4.6 / Task 6.3", id, `Rejected: ${title}`, `GET ${API}/reservations with ${value === undefined ? "no cookie" : `cookie ${shorten(value)}`}`,
        "401 not_signed_in", summary(res), res.status === 401 && res.body.error.code === "not_signed_in");
    }

    const loggedOut = await as("Waiter");
    const copied = loggedOut.jar[SESSION_COOKIE];
    await loggedOut.post(`${API}/auth/logout`, {});
    const replay = await withToken(copied);
    record("Task 4.6 / Task 6.3", "A6-12", "Rejected: a genuine token after sign-out (server-side revocation)",
      `POST ${API}/auth/logout, then reuse the old cookie on GET ${API}/reservations`, "401 not_signed_in",
      summary(replay), replay.status === 401);

    // ---------- Task 5 / Task 6.4: role-based access ----------
    const kitchen = await as("Kitchen");
    const manager = await as("Manager");

    // ---------- Module 1: Reservations (Task 2, 3, 6.5) ----------
    const booking = { name: "Ayesha Khan", phone: PHONE, date: futureDate(), time: "19:30", party: 4, notes: "Window seat" };
    const created = await waiter.post(`${API}/reservations`, booking, idem());
    record("Task 2.1 / Task 6.5", "A6-13", "Module 1 (Reservations): waiter submits a reservation",
      `POST ${API}/reservations ${JSON.stringify(booking)}`, "201 with the saved reservation, phone masked",
      summary(created), created.status === 201 && /^R-\d+$/.test(created.body.id) && created.body.phone !== PHONE);

    const rawRes = created.body.id && await db.collection("reservations").findOne({ _id: created.body.id });
    record("Task 1.4", "A6-14", "Module 1: the reservation is stored in MongoDB (guest details encrypted)",
      `db.reservations.findOne({_id: "${created.body.id}"})`, "Document exists; name and phone are not stored as plain text",
      { found: Boolean(rawRes), fields: rawRes ? Object.keys(rawRes) : [] },
      rawRes && !JSON.stringify(rawRes).includes("Ayesha") && !JSON.stringify(rawRes).includes(PHONE));

    const listed = await waiter.get(`${API}/reservations`);
    record("Task 2.2 / Task 1.5 / Task 6.5", "A6-15", "Module 1: stored reservations are retrieved",
      `GET ${API}/reservations`, "200 and the list contains the new reservation",
      { status: listed.status, count: listed.body.reservations && listed.body.reservations.length, ids: (listed.body.reservations || []).map((r) => r.id) },
      listed.status === 200 && listed.body.reservations.some((r) => r.id === created.body.id));

    const badParty = await waiter.post(`${API}/reservations`, { ...booking, party: 50 }, idem());
    record("Task 2.4 / Task 5.3", "A6-16", "Module 1: invalid input is refused with a clear message",
      `POST ${API}/reservations with party: 50`, "400 invalid_input with a user-friendly message",
      summary(badParty), badParty.status === 400 && badParty.body.error.code === "invalid_input");

    const injection = await waiter.post(`${API}/reservations/search`, { phone: { $ne: "" } });
    record("Task 5.4", "A6-17", "Module 1: NoSQL injection operator is refused",
      `POST ${API}/reservations/search {"phone": {"$ne": ""}}`, "400 invalid_input; no records returned",
      summary(injection), injection.status === 400 && !injection.body.reservations);

    const extraField = await waiter.post(`${API}/reservations`, { ...booking, time: "20:30", status: "Confirmed" }, idem());
    record("Task 5.3", "A6-18", "Module 1: unknown fields (mass assignment) are refused",
      `POST ${API}/reservations with an extra field status: "Confirmed"`, "400 invalid_input",
      summary(extraField), extraField.status === 400);

    const status = await waiter.post(`${API}/reservations/${created.body.id}/status`, { status: "Seated" });
    record("Task 2 (update)", "A6-19", "Module 1: reservation status is updated",
      `POST ${API}/reservations/${created.body.id}/status {"status": "Seated"}`, "200 (staff bookings start as Confirmed)",
      summary(status), status.status === 200);

    // ---------- Module 2: Orders (Task 2, 3, 6.5) ----------
    const order = { table: 3, lines: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }], notes: "No sugar" };
    const placed = await waiter.post(`${API}/orders`, order, idem());
    record("Task 2.1 / Task 6.5", "A6-20", "Module 2 (Orders): waiter places an order; prices and totals worked out on the server",
      `POST ${API}/orders ${JSON.stringify(order)}`, "201 with order id, items priced from the database and totals",
      summary(placed), placed.status === 201 && /^ORD-\d+$/.test(placed.body.id) && placed.body.totals && placed.body.totals.total > 0);

    const own = await waiter.get(`${API}/orders`);
    record("Task 2.2 / Task 6.5", "A6-21", "Module 2: stored orders are retrieved",
      `GET ${API}/orders`, "200 and the list contains the new order",
      { status: own.status, ids: (own.body.orders || []).map((o) => o.id) },
      own.status === 200 && own.body.orders.some((o) => o.id === placed.body.id));

    const priced = await waiter.post(`${API}/orders`, { table: 4, lines: [{ id: 1, qty: 1, price: 1 }] }, idem());
    record("Task 5.3", "A6-22", "Module 2: a price sent by the browser is refused",
      `POST ${API}/orders with lines[0].price: 1`, "400 invalid_input",
      summary(priced), priced.status === 400);

    const tickets = await kitchen.get(`${API}/kitchen/tickets`);
    record("Task 2 / integration", "A6-23", "Module 2: the order reaches the kitchen from the same database",
      `GET ${API}/kitchen/tickets as Kitchen`, "200 and the ticket list contains the order, with no prices",
      { status: tickets.status, ids: (tickets.body.tickets || []).map((t) => t.id) },
      tickets.status === 200 && tickets.body.tickets.some((t) => t.id === placed.body.id) && !JSON.stringify(tickets.body).includes("price"));

    // ---------- Role-based access (Task 5.1, 5.2, 6.4) ----------
    const rbac = [
      ["A6-24", "Kitchen cannot read reservations", kitchen, "get", `${API}/reservations`, 403],
      ["A6-25", "Kitchen cannot place orders", kitchen, "post", `${API}/orders`, 403, { table: 5, lines: [{ id: 1, qty: 1 }] }],
      ["A6-26", "Waiter cannot reveal a guest's full phone number", waiter, "get", `${API}/reservations/${created.body.id}/phone`, 403],
      ["A6-27", "Waiter cannot open the audit log", waiter, "get", `${API}/audit`, 403],
      ["A6-28", "Manager cannot manage staff accounts (Admin only)", manager, "get", "/api/v1/users", 403],
      ["A6-29", "Manager can reveal the guest's phone (allowed role)", manager, "get", `${API}/reservations/${created.body.id}/phone`, 200],
      ["A6-30", "Manager can also manage reservations (allowed role)", manager, "get", `${API}/reservations`, 200]
    ];
    for (const [id, title, client, method, url, expected, body] of rbac) {
      const res = method === "get" ? await client.get(url) : await client.post(url, body, idem());
      record("Task 5.1, 5.2 / Task 6.4", id, title, `${method.toUpperCase()} ${url}`, `${expected}${expected === 403 ? " forbidden" : ""}`,
        summary(res), res.status === expected);
    }
    const denied = await db.collection("audit_events").countDocuments({ action: "Access denied" });
    record("Task 5.2", "A6-31", "Every refused attempt is written to the audit log",
      "db.audit_events.countDocuments({action: \"Access denied\"})", "At least 5 entries (one per refusal above)",
      { accessDeniedEntries: denied }, denied >= 5);

    // ---------- Registration with Admin approval (Task 4 / Task 5) ----------
    const reg = { name: "Ahmed Raza", username: "ahmed.raza", password: "Brewing-Coffee-42!" };
    const registered = await h.browser(app).post(`${API}/public/register`, reg);
    record("Task 4 (register)", "A6-32", "Registration from the landing page is accepted",
      `POST ${API}/public/register {name, username: "ahmed.raza", password}`, "202 with a 'waiting for approval' message",
      summary(registered), registered.status === 202);

    const regDoc = await db.collection("users").findOne({ username: reg.username });
    record("Task 4.3 / Task 1.4", "A6-33", "The new account is stored as Pending with an Argon2id hash",
      "db.users.findOne({username: \"ahmed.raza\"})", "status Pending; passwordHash starts with $argon2id$; no plaintext",
      { status: regDoc && regDoc.status, passwordHash: regDoc && shorten(regDoc.passwordHash) },
      regDoc && regDoc.status === "Pending" && regDoc.passwordHash.startsWith("$argon2id$") && !JSON.stringify(regDoc).includes(reg.password));

    const weak = await h.browser(app).post(`${API}/public/register`, { ...reg, username: "weak.user", password: "password" });
    record("Task 5.3", "A6-34", "A weak password is refused by the server",
      `POST ${API}/public/register with password "password"`, "400 weak_password", summary(weak), weak.status === 400);

    const pendingLogin = await h.browser(app).post(`${API}/auth/login`, { username: reg.username, password: reg.password });
    record("Task 5.2", "A6-35", "A Pending account cannot sign in",
      `POST ${API}/auth/login as ahmed.raza before approval`, "401 sign_in_failed", summary(pendingLogin), pendingLogin.status === 401);

    const waiterApprove = await waiter.post(`${API}/users/${reg.username}/approve`, { role: "Waiter" });
    record("Task 5.1, 5.2", "A6-36", "A Waiter cannot approve registrations",
      `POST ${API}/users/ahmed.raza/approve as Waiter`, "403 forbidden", summary(waiterApprove), waiterApprove.status === 403);

    const adminUser = await h.createUser(db, config, { role: "Admin" });
    const admin = await h.signIn(app, db, adminUser);
    const asAdminRole = await (async () => { await admin.post(`${API}/auth/step-up`, { code: await h.freshCode(db, adminUser) }); return admin.post(`${API}/users/${reg.username}/approve`, { role: "Admin" }); })();
    record("Task 5.1", "A6-37", "Admin access cannot be granted through a registration",
      `POST ${API}/users/ahmed.raza/approve {"role": "Admin"} as Admin`, "400 invalid_input", summary(asAdminRole), asAdminRole.status === 400);

    const approved = await admin.post(`${API}/users/${reg.username}/approve`, { role: "Kitchen" });
    record("Task 5.1", "A6-38", "Admin approves the registration and chooses the role",
      `POST ${API}/users/ahmed.raza/approve {"role": "Kitchen"} as Admin (after authenticator step-up)`, "200; account Active as Kitchen",
      summary(approved), approved.status === 200 && approved.body.status === "Active" && approved.body.role === "Kitchen");

    const afterApproval = await h.browser(app).post(`${API}/auth/login`, { username: reg.username, password: reg.password });
    record("Task 4.1", "A6-39", "After approval the new account can sign in",
      `POST ${API}/auth/login as ahmed.raza after approval`, "200 and signed in (a Kitchen role needs no authenticator)", summary(afterApproval),
      afterApproval.status === 200 && afterApproval.body.next === "done");

    // ---------- Task 5.5: no technical details in errors ----------
    const malformed = await h.browser(app).post(`${API}/auth/login`, "{\"username\": ", { headers: { "Content-Type": "application/json" } });
    const text = JSON.stringify(malformed.body);
    record("Task 5.5", "A6-40", "Malformed JSON gets a generic error with no stack trace or library names",
      `POST ${API}/auth/login with body {"username":  (cut off)`, "400 with a short message; no stack, file path or library name",
      summary(malformed), malformed.status === 400 && !/\bat \S+ \(|\.js\b|SyntaxError|node_modules|stack/i.test(text));

    const unknown = await waiter.get(`${API}/no-such-route`);
    record("Task 5.5", "A6-41", "Unknown API route gets a generic not-found error",
      `GET ${API}/no-such-route`, "404 with a generic message", summary(unknown), unknown.status === 404 && !/\.js|stack/i.test(JSON.stringify(unknown.body)));

    return { results, permissions: PERMISSIONS };
  } finally {
    await ctx.stop();
  }
}

// ---------- API endpoint list, generated from the live router ----------
function endpointList() {
  const { build } = require(path.join(ROOT, "scripts", "openapi.js"));
  const { loadConfig } = require(path.join(ROOT, "server", "config"));
  const { createApp } = require(path.join(ROOT, "server", "app"));
  const { createLogger } = require(path.join(ROOT, "server", "lib", "logger"));
  const config = loadConfig(h.testEnv());
  const app = createApp({ config, db: { collection: () => ({}) }, logger: createLogger(config) });
  return Object.entries(build(app).paths).flatMap(([p, methods]) => Object.keys(methods).map((m) => ({ method: m.toUpperCase(), path: p })));
}

function guardsFor() {
  // Reads each route's guard and permission straight from the route files, so the table matches the code
  const map = new Map();
  const files = { "business.js": "/api/v1", "auth.js": "/api/v1/auth", "public.js": "/api/v1/public", "users.js": "/api/v1/users" };
  for (const [file, prefix] of Object.entries(files)) {
    const source = fs.readFileSync(path.join(ROOT, "server", "routes", file), "utf8");
    for (const m of source.matchAll(/router\.(get|post|put|delete)\("([^"]+)",\s*([^\n]*)/g)) {
      const route = `${prefix}${m[2] === "/" ? "" : m[2]}`.replace(/:([A-Za-z]+)/g, "{$1}");
      const rest = m[3];
      const perm = (rest.match(/allow\("([^"]+)"\)/) || [])[1];
      let access;
      if (perm) access = `${PERMISSIONS[perm].join(", ")} (\`${perm}\`)`;
      else if (rest.startsWith("publicRoute")) access = "Public";
      else if (rest.includes("...view") || rest.includes("...change")) access = "Admin (`users.manage`)";
      else if (rest.includes("requireAuth")) access = "Any signed-in staff";
      else access = "—";
      const extras = [];
      if (rest.includes("validate(") || rest.includes("params(")) extras.push("validated");
      if (rest.includes("requireStepUp")) extras.push("step-up");
      if (rest.includes("requireSignature")) extras.push("signed");
      map.set(`${m[1].toUpperCase()} ${route}`, { access, extras });
    }
  }
  return map;
}

function writeEndpoints() {
  const guards = guardsFor();
  const rows = endpointList()
    .filter((e) => e.path.startsWith("/api/"))
    .map((e) => ({ ...e, ...(guards.get(`${e.method} ${e.path}`) || { access: "Any signed-in staff", extras: [] }) }));
  const isOrders = (r) => /^\/api\/v1\/(orders|tables|kitchen)/.test(r.path);
  const section = (title, filter, note) => {
    const list = rows.filter(filter);
    return [`## ${title}`, "", note, "", "| Method | Endpoint | Who may call it | Checks |", "| --- | --- | --- | --- |",
      ...list.map((r) => `| ${r.method} | \`${r.path}\` | ${r.access} | ${r.extras.join(", ") || "—"} |`), ""].join("\n");
  };
  const md = [
    "# CafeMS API endpoints (Activity 6)",
    "",
    "Generated by `node scripts/activity6-evidence.js` from the live Express router, so it always matches the code. Every route under `/api/v1` except the public ones needs a valid session JWT (`requireAuth`), and every POST/PUT/DELETE also needs the CSRF token and a same-site Origin.",
    "",
    "**Checks:** *validated* = strict Zod schema, unknown fields and NoSQL operators refused; *step-up* = a fresh authenticator code; *signed* = signed by the person's device key.",
    "",
    section("Module 1: Reservations", (r) => r.path.includes("/reservations"), "Customer table requests (public) and the staff reservation list, search and status changes."),
    section("Module 2: Orders and kitchen", isOrders, "Waiter orders (create, read, edit, serve, cancel) and the kitchen ticket board that reads the same orders."),
    section("Authentication and sessions", (r) => r.path.startsWith("/api/v1/auth"), "Login, authenticator verification, JWT session, sign-out and account security."),
    section("Other modules", (r) => !r.path.includes("/reservations") && !isOrders(r) && !r.path.startsWith("/api/v1/auth"), "Menu, billing, inventory, reports, users, audit and the rest of the system.")
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "API-ENDPOINTS.md"), md);
  return rows.length;
}

function writeResults(results) {
  fs.writeFileSync(path.join(OUT, "test-results.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), passed: results.filter((r) => r.pass).length, total: results.length, results }, null, 2)}\n`);
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const actual = (a) => {
    const parts = [];
    if (a.status !== undefined) parts.push(`**${a.status}**`);
    const rest = { ...a };
    delete rest.status;
    const body = rest.body;
    if (body && body.error) parts.push(`\`${body.error.code}\`: ${body.error.message}`);
    else if (Object.keys(rest).length) parts.push(`\`${esc(JSON.stringify(body !== undefined && Object.keys(rest).length === 1 ? body : rest)).slice(0, 260)}\``);
    return parts.join(" ");
  };
  const md = [
    "# Activity 6 test results",
    "",
    `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`node scripts/activity6-evidence.js\`. The actual results are read from the live server responses and the database, not written by hand.`,
    "",
    `**${results.filter((r) => r.pass).length} of ${results.length} cases passed.**`,
    "",
    "| ID | Requirement | Case | Request | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.task} | ${esc(r.title)} | \`${esc(r.request).slice(0, 160)}\` | ${esc(r.expected)} | ${actual(r.actual)} | ${r.pass ? "Pass" : "**FAIL**"} |`),
    ""
  ].join("\n");
  fs.writeFileSync(path.join(OUT, "TEST-RESULTS.md"), md);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { results } = await runCases();
  writeResults(results);
  const endpoints = writeEndpoints();
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.title}`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed. ${endpoints} API endpoints listed. Wrote docs/activity-6/.`);
  process.exitCode = failed.length ? 1 : 0;
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { runCases };
