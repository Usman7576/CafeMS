const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { AppError } = require("../lib/errors");

function securityHeaders(config) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // The browser refuses any script that writes HTML into the page from a plain string
        requireTrustedTypesFor: ["'script'"],
        ...(config.usesTls ? { upgradeInsecureRequests: [] } : {})
      }
    },
    strictTransportSecurity: config.usesTls ? { maxAge: 31536000, includeSubDomains: true } : false,
    // Matches the CSP's frame-ancestors 'none' for older browsers that only read this header
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    // Everything the pages load is self-hosted, so nothing from another site can be embedded
    crossOriginEmbedderPolicy: { policy: "require-corp" }
  });
}

function permissionsPolicy(_req, res, next) {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  next();
}

function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

function noStore(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function limiter(windowMs, max, message, options = {}) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...options,
    handler: (_req, _res, next) => next(new AppError(429, "rate_limited", message))
  });
}

// Blocks cross-site state changes, including login CSRF. Browsers always send Origin on these
// requests, so a missing value is refused too (fail-secure).
function csrfOriginProtection(config) {
  return function csrfCheckOrigin(req, _res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("origin") !== config.appOrigin) return next(new AppError(403, "bad_origin", "This request was blocked."));
    return next();
  };
}

module.exports = { securityHeaders, permissionsPolicy, requestId, noStore, limiter, csrfOriginProtection };
