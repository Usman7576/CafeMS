// Every route must carry a guard. A test walks all routes and fails if one has none,
// so a new route cannot be left open by accident (complete mediation).
const { safeEqual } = require("../lib/crypto");
const { can } = require("../lib/permissions");
const { AppError, notSignedIn, forbidden, invalidInput } = require("../lib/errors");
const { recordEvent } = require("../services/auditLog");

function guard(kind, fn) {
  fn.guard = kind;
  return fn;
}

const publicRoute = guard("public", function publicRoute(_req, _res, next) { next(); });

function createAuthMiddleware(config, db, sessions) {
  const requireAuth = guard("auth", async function requireAuth(req, _res, next) {
    try {
      const auth = await sessions.load(req);
      if (!auth) throw notSignedIn();
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const token = req.get("x-csrf-token");
        if (!token || !safeEqual(token, auth.session.csrfToken)) throw new AppError(403, "bad_csrf", "This request was blocked. Reload the page and try again.");
      }
      req.auth = auth;
      next();
    } catch (error) {
      next(error);
    }
  });

  function requirePermission(permission) {
    return guard("permission", async function checkPermission(req, _res, next) {
      try {
        if (!req.auth) throw notSignedIn();
        if (!can(req.auth.user.role, permission)) {
          await recordEvent(db, req, {
            actor: req.auth.user.username, role: req.auth.user.role, action: "Access denied",
            details: `${req.method} ${req.baseUrl}${req.path} needs ${permission}`, severity: "warning"
          });
          throw forbidden();
        }
        next();
      } catch (error) {
        next(error);
      }
    });
  }

  // A sensitive action needs a recent authenticator code as well as a valid session
  const requireStepUp = guard("step-up", function requireStepUp(req, _res, next) {
    const at = req.auth && req.auth.session.stepUpAt;
    if (!at || Date.now() - at.getTime() > config.auth.stepUpMs) {
      return next(new AppError(403, "step_up_required", "Confirm your authenticator code to continue."));
    }
    return next();
  });

  return { requireAuth, requirePermission, requireStepUp };
}

// Strict schema validation; unknown fields and wrong types (such as NoSQL operator objects) are refused.
// Only messages written for users (marked "!") are shown; anything else stays generic.
const TARGET = Object.freeze({ body: "body", params: "validParams", query: "validQuery" });

function validate(schema, source = "body") {
  return function validateInput(req, _res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const friendly = result.error.issues.find((issue) => String(issue.message).startsWith("!"));
      return next(friendly ? new AppError(400, "invalid_input", friendly.message.slice(1)) : invalidInput());
    }
    req[TARGET[source]] = result.data;
    return next();
  };
}

module.exports = { guard, publicRoute, createAuthMiddleware, validate };
