// Project Activity 5 (frontend secure coding). These checks keep the frontend guarantees from being
// lost by a later change; scripts/activity5-evidence.js shows the same things working in a real browser.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const h = require("./helpers");

const PUBLIC = path.join(__dirname, "..", "public");
const JS = path.join(PUBLIC, "js");
const read = (...p) => fs.readFileSync(path.join(...p), "utf8");
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
const scripts = fs.readdirSync(JS).filter((f) => f.endsWith(".js"));
// Our own scripts; the instructor's helper is checked separately and left exactly as supplied
const ours = scripts.filter((f) => f !== "password_strength_helper.js");

test("the instructor's password_strength_helper.js is included unchanged", () => {
  const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(JS, "password_strength_helper.js"))).digest("hex");
  assert.strictEqual(digest, "539b97de37bf10bfa4c625836f8552773ba52cc092fd975f13333b2a2d683191");
});

test("both password pages load the helper before the page script and call checkPasswordStrength on input", () => {
  for (const [page, script] of [["account.html", "account.js"], ["setup.html", "setup.js"]]) {
    const html = read(PUBLIC, page);
    const helper = html.indexOf('src="js/password_strength_helper.js"');
    assert.ok(helper > 0, `${page} loads the helper`);
    assert.ok(helper < html.indexOf(`src="js/${script}`), `${page} loads it before ${script}`);
    assert.match(read(JS, script), /Validate\.attachStrength\(/);
  }
  const validate = read(JS, "validate.js");
  assert.match(validate, /window\.checkPasswordStrength\(inputEl\.value\)/);
  assert.match(validate, /\["input", "change", "paste", "cut"\]/);
});

test("every page with a form loads the validation helper after common.js", () => {
  for (const page of pages) {
    const html = read(PUBLIC, page);
    if (!/<form/.test(html)) continue;
    const common = html.indexOf('src="js/common.js');
    const validate = html.indexOf('src="js/validate.js');
    assert.ok(validate > common && common > 0, `${page} loads validate.js after common.js`);
  }
});

test("at least the two reservation forms validate required fields, lengths, formats and trimming", () => {
  for (const file of ["home.js", "reservation.js"]) {
    const src = read(JS, file);
    assert.match(src, /Validate\.attach\(/, file);
    assert.match(src, /required: true, min: 2, max: 60, format: "personName"/, `${file}: name 2-60`);
    assert.match(src, /format: "mobile"/, `${file}: mobile format`);
    assert.match(src, /number: \{ min: 1, max: 20 \}/, `${file}: party size range`);
    assert.match(src, /max: 160/, `${file}: notes limit`);
    assert.match(src, /\.check\(\)/, `${file}: checked before sending`);
  }
  const validate = read(JS, "validate.js");
  assert.match(validate, /\.trim\(\)/, "values are trimmed");
  assert.match(validate, /is required\./, "required message");
  assert.match(validate, /must be at least/, "minimum length message");
  assert.match(validate, /characters or fewer\./, "maximum length message");
  assert.match(validate, /\/\^03\\d\{9\}\$\//, "mobile format matches the server's");
});

test("the menu photo picker restricts extensions, type, size and contents to the server's 2 MB limit", () => {
  const menu = read(JS, "menu.js");
  assert.match(menu, /types: \{ "\.png": "png", "\.jpg": "jpeg", "\.jpeg": "jpeg", "\.webp": "webp" \}/);
  assert.match(menu, /maxBytes: 2 \* 1024 \* 1024/);
  assert.match(menu, /Validate\.attachFile\(document\.getElementById\("fPhoto"\)/);
  assert.match(menu, /await photoCheck\.check\(\)/, "checked again just before upload");
  const validate = read(JS, "validate.js");
  for (const piece of ["not an allowed file type", "The largest file allowed is", "its contents are not a", "is empty"]) assert.ok(validate.includes(piece), piece);
  assert.match(read(path.join(__dirname, "..", "server"), "config.js"), /photoBody: "2mb"/);
});

test("no script builds HTML from strings, and the DOM helper refuses javascript: links and string handlers", () => {
  // Comments are removed first: they may name these APIs to explain why they are not used
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of scripts) {
    const src = code(read(JS, file));
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\s*\(/, file);
  }
  const common = read(JS, "common.js");
  assert.match(common, /URL_ATTRS\.indexOf\(k\.toLowerCase\(\)\) !== -1\) el\.setAttribute\(k, safeUrl\(v\)\)/);
  assert.match(common, /if \(typeof v === "function"\) el\.addEventListener/);
  assert.match(read(path.join(__dirname, "..", "server", "middleware"), "security.js"), /requireTrustedTypesFor: \["'script'"\]/);
});

test("passwords and secrets are never written to browser storage", () => {
  for (const file of ours) {
    const src = read(JS, file);
    assert.doesNotMatch(src, /localStorage\.setItem/, `${file} writes nothing to localStorage`);
    const writes = src.match(/sessionStorage\.setItem\([^,]+/g) || [];
    for (const w of writes) assert.match(w, /this\.KEY|"cms_flash"/, `${file}: ${w}`);
  }
  const common = read(JS, "common.js");
  assert.match(common, /const SESSION_FIELDS = \["user", "name", "role", "loginAt"\]/);
  assert.match(common, /const STORAGE_KEYS = \["cms_session", "cms_flash"\]/);
  assert.match(common, /localStorage\.clear\(\)/);
});

test("frontend files hold no private keys, API keys, server secrets or database passwords", () => {
  const patterns = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/, /AKIA[0-9A-Z]{16}/, /(?:JWT_KEYS|DATA_KEYS|AUDIT_KEYS|BLIND_INDEX_KEY|GATEWAY_SECRET)\s*[:=]/, /mongodb(?:\+srv)?:\/\/[^\s"']+:[^\s"']+@/];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  for (const file of walk(PUBLIC).filter((f) => /\.(js|html|css|json)$/.test(f))) {
    const text = fs.readFileSync(file, "utf8");
    for (const p of patterns) assert.doesNotMatch(text, p, `${path.relative(PUBLIC, file)} ${p}`);
  }
});

test("sign-out wipes the page state and the browser's cached pages", async () => {
  const common = read(JS, "common.js");
  assert.match(common, /wipe: function \(\)/);
  assert.match(read(JS, "app.js"), /Session\.wipe\(\);\s*\n\s*if \(msg\) Session\.flash\(msg\)/);
  assert.match(read(JS, "store.js"), /forget: function \(\)/);
  assert.match(common, /addEventListener\("pageshow"/);

  const { db, stop } = await h.startDb();
  try {
    const { config, app } = h.buildApp(db);
    const user = await h.createUser(db, config, { role: "Waiter" });
    const client = await h.signIn(app, db, user);
    const out = await client.post("/api/v1/auth/logout", {});
    assert.strictEqual(out.status, 204);
    assert.strictEqual(out.headers["clear-site-data"], "\"cache\"");
    assert.strictEqual((await client.get("/api/v1/auth/me")).status, 401);
  } finally {
    await stop();
  }
});
