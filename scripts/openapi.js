// Usage: node scripts/openapi.js <output.json>
// Writes an OpenAPI description of every route, generated from the live router and its validation
// schemas, so it cannot go out of date. The active ZAP scan uses it to reach the signed-in API.
const fs = require("fs");
const { z } = require("zod");
const { loadConfig } = require("../server/config");
const { createApp } = require("../server/app");
const { createLogger } = require("../server/lib/logger");

// Sample values, so the scanner sends requests that pass validation and reach the code behind it
const EXAMPLES = Object.freeze({ id: "1", no: "1", username: "demo.user", sid: "aaaaaaaaaaaaaaaaaaaaaa" });
// These would end the scanner's own session part-way through
const SKIP = new Set(["post /api/v1/auth/logout", "delete /api/v1/auth/sessions/{sid}"]);

const MOUNTS = Object.freeze(["/api/v1", "/auth", "/public", "/users"]);

function collect(stack, prefix, found) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const route of paths) {
        for (const method of Object.keys(layer.route.methods)) found.push({ path: `${prefix}${route}`, method, handlers: layer.route.stack.map((s) => s.handle) });
      }
    } else if (layer.handle && layer.handle.stack) {
      // Express keeps a mounted router's path only as a pattern, such as /^\/api\/v1\/?(?=\/|$)/
      // A router mounted at the root matches everything, so it has no path of its own
      const mount = layer.slash ? "" : MOUNTS.find((path) => layer.matchers.some((matches) => matches(`${path}/probe`))) || "";
      collect(layer.handle.stack, prefix + mount, found);
    }
  }
}

function jsonSchema(schema) {
  try {
    return z.toJSONSchema(schema, { target: "openapi-3.0", io: "input", unrepresentable: "any" });
  } catch (error) {
    return { type: "object" };
  }
}

function build(app) {
  const found = [];
  collect(app.router.stack, "", found);
  const paths = {};
  for (const route of found) {
    const openPath = route.path.replace(/:([A-Za-z]+)/g, "{$1}");
    const key = `${route.method} ${openPath}`;
    if (SKIP.has(key)) continue;
    const operation = { responses: { default: { description: "Response" } } };
    const parameters = [...openPath.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({
      name: m[1], in: "path", required: true, schema: { type: "string", example: Object.hasOwn(EXAMPLES, m[1]) ? EXAMPLES[m[1]] : "1" }
    }));
    if (parameters.length) operation.parameters = parameters;
    const body = route.handlers.find((h) => h.schema && h.source === "body");
    if (body) operation.requestBody = { content: { "application/json": { schema: jsonSchema(body.schema) } } };
    paths[openPath] = { ...(paths[openPath] || {}), [route.method]: operation };
  }
  return { openapi: "3.0.3", info: { title: "CafeMS API", version: "1.0.0" }, paths };
}

function main(output) {
  const zeros = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) zeros[i] = i + 1;
  const key = (n) => { const b = Buffer.from(zeros); b[0] = n; return b.toString("base64"); };
  // Throwaway keys and a stand-in database: the routes are only listed here, never run
  const config = loadConfig({
    NODE_ENV: "test", APP_ORIGIN: "http://localhost:3000", JWT_KEYS: `k1:${key(100)}`, JWT_ACTIVE_KEY: "k1", DATA_KEYS: `k1:${key(101)}`, DATA_ACTIVE_KEY: "k1",
    BLIND_INDEX_KEY: key(102), AUDIT_KEYS: `k1:${key(103)}`, AUDIT_ACTIVE_KEY: "k1", GATEWAY_SECRET: key(104)
  });
  const app = createApp({ config, db: { collection: () => ({}) }, logger: createLogger(config) });
  fs.writeFileSync(output, JSON.stringify(build(app), null, 1));
  console.log(`Wrote ${output}`);
}

if (require.main === module) main(process.argv[2] || "openapi.json");

module.exports = { build };
