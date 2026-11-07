// Sessions are a signed JWT in an HttpOnly cookie plus a server record. The JWT proves the
// cookie is genuine; the record allows instant revocation and is checked on every request.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { randomToken } = require("../lib/crypto");
const { clean } = require("./auditLog");

const SESSION_COOKIE = "__Host-cms_session";
const PREAUTH_COOKIE = "__Host-cms_preauth";
const ALGORITHM = "HS256";
const ISSUER = "cafems";
const AUDIENCE = "cafems-staff";
const TOUCH_INTERVAL_MS = 15 * 1000;

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge };
}

function createSessionService(config, db) {
  const sessions = db.collection("sessions");
  const users = db.collection("users");

  function sign(user, jti) {
    return jwt.sign({ jti }, config.jwt.keys.get(config.jwt.activeId), {
      algorithm: ALGORITHM,
      keyid: config.jwt.activeId,
      subject: user.username,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: Math.floor(config.auth.sessionAbsoluteMs / 1000)
    });
  }

  function verifyToken(token) {
    try {
      const decoded = jwt.decode(token, { complete: true });
      const key = decoded && config.jwt.keys.get(decoded.header.kid);
      if (!key) return null;
      return jwt.verify(token, key, { algorithms: [ALGORITHM], issuer: ISSUER, audience: AUDIENCE });
    } catch (error) {
      return null;
    }
  }

  // Saves the session record (inside the caller's transaction, when one is given) and returns the
  // signed token. The cookie is set only after the transaction commits, by setCookie.
  async function create(user, req, txn) {
    const now = Date.now();
    const jti = crypto.randomUUID();
    await sessions.insertOne({
      jti,
      sid: randomToken(16),
      username: user.username,
      role: user.role,
      csrfToken: randomToken(32),
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      absoluteExpiresAt: new Date(now + config.auth.sessionAbsoluteMs),
      stepUpAt: null,
      ip: clean(req.ip),
      userAgent: clean(req.get("user-agent"))
    }, { session: txn });
    await users.updateOne({ username: user.username }, { $set: { lastLogin: new Date(now) } }, { session: txn });
    return sign(user, jti);
  }

  function setCookie(res, token) {
    res.cookie(SESSION_COOKIE, token, cookieOptions(config.auth.sessionAbsoluteMs));
    res.clearCookie(PREAUTH_COOKIE, cookieOptions());
  }

  // A session that has timed out is no longer signed in, so it is removed rather than listed
  function isLive(session, now = Date.now()) {
    return now - session.lastSeenAt.getTime() <= config.auth.sessionIdleMs && now <= session.absoluteExpiresAt.getTime();
  }

  // Returns { user, session } only if every check passes; any failure means "not signed in".
  async function load(req) {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    if (typeof token !== "string") return null;
    const payload = verifyToken(token);
    if (!payload || typeof payload.jti !== "string") return null;

    const session = await sessions.findOne({ jti: payload.jti });
    if (!session || session.username !== payload.sub) return null;

    const now = Date.now();
    if (!isLive(session, now)) {
      await sessions.deleteOne({ jti: session.jti });
      return null;
    }

    // Roles and account status are read fresh, so a change applies to the very next request
    const user = await users.findOne({ username: session.username });
    if (!user || user.status !== "Active" || user.role !== session.role) {
      await sessions.deleteOne({ jti: session.jti });
      return null;
    }

    // Automatic background refreshes must not keep an idle session alive
    const isBackground = req.get("x-background-refresh") === "1";
    if (!isBackground && now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await sessions.updateOne({ jti: session.jti }, { $set: { lastSeenAt: new Date(now) } });
    }
    return { user, session };
  }

  async function revoke(jti, res, txn) {
    await sessions.deleteOne({ jti }, { session: txn });
    if (res) res.clearCookie(SESSION_COOKIE, cookieOptions());
  }

  return { create, setCookie, isLive, load, revoke, revokeAll: (username, txn) => sessions.deleteMany({ username }, { session: txn }) };
}

module.exports = { createSessionService, cookieOptions, SESSION_COOKIE, PREAUTH_COOKIE };
