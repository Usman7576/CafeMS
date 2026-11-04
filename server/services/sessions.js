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

  async function create(user, req, res) {
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
    });
    await users.updateOne({ username: user.username }, { $set: { lastLogin: new Date(now) } });
    res.cookie(SESSION_COOKIE, sign(user, jti), cookieOptions(config.auth.sessionAbsoluteMs));
    res.clearCookie(PREAUTH_COOKIE, cookieOptions());
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
    const idle = now - session.lastSeenAt.getTime() > config.auth.sessionIdleMs;
    const expired = now > session.absoluteExpiresAt.getTime();
    if (idle || expired) {
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

  async function revoke(jti, res) {
    await sessions.deleteOne({ jti });
    if (res) res.clearCookie(SESSION_COOKIE, cookieOptions());
  }

  return { create, load, revoke, revokeAll: (username) => sessions.deleteMany({ username }) };
}

module.exports = { createSessionService, cookieOptions, SESSION_COOKIE, PREAUTH_COOKIE };
