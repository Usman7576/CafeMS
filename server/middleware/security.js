const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { AppError } = require("../lib/errors");

// Transitional until Phase 3 removes inline styles, Google Fonts and innerHTML. Phase 3 then
// drops 'unsafe-inline' and these font hosts, and turns on require-trusted-types-for.
const TRANSITIONAL_STYLE_SOURCES = ["'unsafe-inline'", "https://fonts.googleapis.com"];
const TRANSITIONAL_FONT_SOURCES = ["https://fonts.gstatic.com"];

function securityHeaders(config) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", ...TRANSITIONAL_STYLE_SOURCES],
        fontSrc: ["'self'", ...TRANSITIONAL_FONT_SOURCES],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.usesTls ? { upgradeInsecureRequests: [] } : {})
      }
    },
    strictTransportSecurity: config.usesTls ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" }
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

function limiter(windowMs, max, message) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, "rate_limited", message))
  });
}

// Blocks cross-site state changes, including login CSRF. Browsers always send Origin on these
// requests, so a missing value is refused too (fail-secure).
function originCheck(config) {
  return function checkOrigin(req, _res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("origin") !== config.appOrigin) return next(new AppError(403, "bad_origin", "This request was blocked."));
    return next();
  };
}

module.exports = { securityHeaders, permissionsPolicy, requestId, noStore, limiter, originCheck };
