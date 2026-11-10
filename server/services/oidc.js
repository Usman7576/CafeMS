// Sign-in with an organisation account through OpenID Connect (Week 2, slide 29: use standard protocols
// such as OAuth or OpenID Connect rather than a home-made one). It replaces only the password step;
// the cafe's own authenticator code or passkey is still asked for afterwards.
// The flow uses PKCE, a state value bound to this browser by a cookie, and a nonce in the ID token.
const client = require("openid-client");
const { AppError } = require("../lib/errors");
const { hashToken } = require("../lib/crypto");

const FLOW_MS = 10 * 60 * 1000;

function createOidcService({ config, db }) {
  const flows = db.collection("oidc_flows");
  let discovered = null;

  async function provider() {
    if (!config.oidc) throw new AppError(404, "not_found", "Organisation sign-in is not set up.");
    if (!discovered) {
      // ID token signatures are checked against the provider's published keys as well as relying on
      // TLS, so a forged or altered token is refused even if the connection were intercepted
      const execute = [client.enableNonRepudiationChecks, ...(config.oidc.allowHttp ? [client.allowInsecureRequests] : [])];
      discovered = client.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret, undefined, { execute })
        .catch((error) => { discovered = null; throw error; });
    }
    return discovered;
  }

  const redirectUri = () => `${config.appOrigin}/api/v1/auth/oidc/callback`;

  // Starts a flow and returns where to send the browser, plus the value for the binding cookie
  async function start(mode, username) {
    const settings = await provider();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    await flows.insertOne({ _id: hashToken(state), mode, username: username || null, codeVerifier, nonce, expiresAt: new Date(Date.now() + FLOW_MS) });
    const url = client.buildAuthorizationUrl(settings, {
      redirect_uri: redirectUri(), scope: "openid", state, nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: "S256"
    });
    return { url: url.href, state };
  }

  // Finishes a flow. The state must match this browser's cookie, and the flow works once.
  async function finish(currentUrl, cookieState) {
    const state = currentUrl.searchParams.get("state");
    if (!state || !cookieState || state !== cookieState) throw new AppError(400, "oidc_failed", "That sign-in did not start in this browser.");
    const flow = await flows.findOneAndDelete({ _id: hashToken(state) });
    if (!flow || flow.expiresAt.getTime() <= Date.now()) throw new AppError(400, "oidc_failed", "That sign-in has expired. Please start again.");
    const settings = await provider();
    let claims;
    try {
      const tokens = await client.authorizationCodeGrant(settings, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true
      });
      claims = tokens.claims();
    } catch {
      throw new AppError(401, "oidc_failed", "The organisation sign-in was not accepted.");
    }
    if (!claims || !claims.sub || !claims.iss) throw new AppError(401, "oidc_failed", "The organisation sign-in was not accepted.");
    return { mode: flow.mode, username: flow.username, identity: { iss: claims.iss, sub: claims.sub } };
  }

  return { start, finish, enabled: () => Boolean(config.oidc) };
}

module.exports = { createOidcService };
