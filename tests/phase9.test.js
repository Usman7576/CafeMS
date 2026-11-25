// Phase 9 (Polish): installable app (manifest, icons, a service worker that never stores private
// pages), caching and compression, accessibility checks on every page, and colour contrast in the light
// and dark themes.
const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { startDb, buildApp } = require("./helpers");

const PUBLIC = path.join(__dirname, "..", "public");
let ctx, app;
before(async () => {
  ctx = await startDb();
  ({ app } = buildApp(ctx.db));
});
after(() => ctx.stop());

describe("installable app", () => {
  test("the manifest names the app and its icons, which exist", async () => {
    const res = await request(app).get("/manifest.webmanifest");
    assert.equal(res.status, 200);
    const manifest = JSON.parse(res.text);
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/login.html");
    for (const icon of manifest.icons) assert.equal((await request(app).get(icon.src)).status, 200, icon.src);
    assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  });

  test("the service worker is always checked with the server and may control the whole site", async () => {
    const res = await request(app).get("/sw.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
    assert.equal(res.headers["service-worker-allowed"], "/");
    assert.match(res.headers["content-security-policy"], /worker-src 'self'/);
  });

  test("the service worker never stores the API or staff pages", () => {
    const sw = fs.readFileSync(path.join(PUBLIC, "sw.js"), "utf8");
    assert.match(sw, /startsWith\("\/api\/"\)\) return/);
    assert.match(sw, /SHARED = \/\^\\\/\(\?:css\|js\|fonts\|assets\|vendor\)\\\/\//, "only shared files are cached");
    assert.doesNotMatch(sw, /cache\.put\(request, response\.clone\(\)\);\s*\n\s*return response;\s*\n\s*\}\)\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*\/\/ Pages[\s\S]*cache\.put/, "navigations are not stored");
    assert.equal((sw.match(/cache\.put/g) || []).length, 1);
  });

  test("the offline page is public", async () => {
    assert.equal((await request(app).get("/offline.html")).status, 200);
  });
});

describe("caching and compression", () => {
  test("versioned files are kept for a year; pages and unversioned files are checked each time", async () => {
    const versioned = await request(app).get("/css/style.css?v=9.7");
    assert.equal(versioned.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal((await request(app).get("/css/style.css")).headers["cache-control"], "no-cache");
    assert.equal((await request(app).get("/index.html")).headers["cache-control"], "no-cache");
    assert.equal((await request(app).get("/dashboard.html")).headers["cache-control"], "no-store", "staff pages are never stored");
    assert.equal((await request(app).get("/api/v1/public/info")).headers["cache-control"], "no-store");
  });

  test("text is compressed for browsers that accept it", async () => {
    const res = await request(app).get("/css/style.css?v=9.7").set("Accept-Encoding", "gzip");
    assert.equal(res.headers["content-encoding"], "gzip");
  });
});

describe("accessibility of every page", () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
  for (const page of pages) {
    test(page, () => {
      const html = fs.readFileSync(path.join(PUBLIC, page), "utf8");
      assert.match(html, /<html lang="en"/, "the language is set");
      assert.match(html, /<title>[^<]+<\/title>/, "the page has a title");
      assert.match(html, /<meta name="viewport"/, "it scales on phones");
      for (const img of html.match(/<img\b[^>]*>/g) || []) assert.match(img, /\balt="/, `${img} has alt text`);
      // Each field has a label: a <label for>, an aria-label, or it is the hidden bot trap
      const ids = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
      // A field inside its <label> is labelled by the label's own text
      const wrapped = (html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) || []).join("");
      for (const field of html.match(/<(input|select|textarea)\b[^>]*>/g) || []) {
        if (/type="(hidden|submit|button)"/.test(field)) continue;
        const id = (field.match(/\bid="([^"]+)"/) || [])[1];
        if (/Website"/.test(field) || /tabindex="-1"/.test(field)) continue;
        assert.ok(/aria-label="/.test(field) || (id && ids.has(id)) || wrapped.includes(field), `${page}: ${field} has a label`);
      }
      // Each button has words, or a label for screen readers
      for (const button of html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []) {
        const text = button.replace(/<[^>]+>/g, "").trim();
        assert.ok(text || /aria-label="/.test(button), `${page}: ${button.slice(0, 80)} has a name`);
      }
    });
  }

  test("focus stays visible and motion can be reduced", () => {
    const css = fs.readFileSync(path.join(PUBLIC, "css", "style.css"), "utf8");
    assert.match(css, /:focus-visible \{[^}]*box-shadow/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /\.skip-link:focus/);
  });
});

describe("colour contrast (WCAG AA, 4.5:1 for text)", () => {
  const css = fs.readFileSync(path.join(PUBLIC, "css", "style.css"), "utf8");
  const tokens = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = tokens(css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {"))));
  const darkStart = css.indexOf(":root[data-theme=\"dark\"] {");
  const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf("}", darkStart))) };

  const parse = (c) => {
    if (c.startsWith("#")) { const hex = c.length === 4 ? c.slice(1).split("").map((x) => x + x).join("") : c.slice(1); return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(1); }
    const m = c.match(/rgba?\(([^)]+)\)/);
    const parts = m[1].split(",").map((x) => parseFloat(x));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  };
  // A see-through colour is mixed with what it sits on
  const over = (top, under) => { const [r, g, b, a] = parse(top); const u = parse(under); return [r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a)]; };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (fg, bg, base) => { const b = over(bg, base); const f = over(fg, `rgb(${b.join(",")})`); const [x, y] = [lum(f), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  const PAIRS = [
    ["ink", "bg"], ["ink", "surface"], ["ink-2", "surface"], ["muted", "surface"], ["muted", "bg"],
    ["accent-600", "surface"], ["accent-600", "accent-50"], ["on-strong", "strong"],
    ["ok", "ok-50"], ["warn", "warn-50"], ["danger", "danger-50"], ["info", "info-50"]
  ];
  for (const [name, t] of [["light", light], ["dark", dark]]) {
    test(`${name} theme`, () => {
      for (const [fg, bg] of PAIRS) {
        const r = ratio(t[fg], t[bg], t.surface);
        assert.ok(r >= 4.5, `${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
      // White text on the filled buttons
      for (const fill of ["accent", "ok-solid", "danger-solid"]) {
        const r = ratio("#ffffff", t[fill], t.surface);
        assert.ok(r >= 4.5, `${name}: white on --${fill} is ${r.toFixed(2)}:1`);
      }
    });
  }
});
