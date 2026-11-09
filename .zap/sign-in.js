// Usage: NODE_EXTRA_CA_CERTS=<caddy root.crt> node .zap/sign-in.js <setup link> <output file>
// Finishes a new Admin's first sign-in on a throwaway stack (password, then authenticator) and writes the
// session cookie and CSRF token, so the active ZAP scan can test the API as a signed-in user.
// TLS is verified against Caddy's own root certificate rather than being switched off.
const fs = require("fs");
const crypto = require("crypto");
const authenticator = require("../server/lib/totp");

const [link, output] = process.argv.slice(2);
const origin = new URL(link).origin;
const token = link.split("#token=")[1];
const jar = {};

async function call(method, path, body) {
  const res = await fetch(origin + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair.indexOf("=");
    if (pair.slice(at + 1)) jar[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}`);
  return res.json();
}

(async () => {
  await call("POST", "/api/v1/auth/setup", { token, password: `Scan-${crypto.randomBytes(12).toString("base64url")}-7a!` });
  const { manualKey } = await call("POST", "/api/v1/auth/mfa/enroll/start", {});
  await call("POST", "/api/v1/auth/mfa/enroll/confirm", { code: authenticator.generate(manualKey) });
  const { csrfToken } = await call("GET", "/api/v1/auth/me");
  fs.writeFileSync(output, JSON.stringify({ cookie: `__Host-cms_session=${jar["__Host-cms_session"]}`, csrfToken, origin }), { mode: 0o600 });
  console.log("Signed in for the scan.");
})().catch((error) => {
  console.error(`Could not sign in for the scan: ${error.message}`);
  process.exit(1);
});
