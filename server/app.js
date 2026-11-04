const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const pinoHttp = require("pino-http");
const { AppError } = require("./lib/errors");
const { PAGES, PUBLIC_PAGES, HOME } = require("./lib/permissions");
const { securityHeaders, permissionsPolicy, requestId, noStore, limiter, originCheck } = require("./middleware/security");
const { createAuthMiddleware, publicRoute } = require("./middleware/auth");
const { createSessionService } = require("./services/sessions");
const { createMfaService } = require("./services/mfa");
const { recordEvent } = require("./services/auditLog");
const { createAuthRouter } = require("./routes/auth");
const { createUsersRouter } = require("./routes/users");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Only these asset folders are served. Everything else not listed as a page is a 404 (default deny).
const ASSET_PATH = /^\/(?:css|js|assets)\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9]+)+$/;

function createApp({ config, db, logger }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  const sessions = createSessionService(config, db);
  const mfa = createMfaService(config, db);
  const middleware = createAuthMiddleware(config, db, sessions);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url.startsWith("/assets/") } }));
  app.use(securityHeaders(config));
  app.use(permissionsPolicy);

  // ---------- API ----------
  const api = express.Router();
  api.use(noStore);
  api.use(limiter(60 * 1000, config.limits.apiPerMinute, "Too many requests. Please wait a moment."));
  api.use(originCheck(config));
  api.use(express.json({ limit: config.limits.jsonBody, strict: true }));
  api.use(cookieParser());

  const authLimiter = limiter(15 * 60 * 1000, config.limits.authPer15Minutes, "Too many attempts. Please wait a few minutes and try again.");
  api.use("/auth", createAuthRouter({ config, db, sessions, mfa, middleware, authLimiter }));
  api.use("/users", createUsersRouter({ config, db, sessions, middleware }));
  api.use((_req, _res, next) => next(new AppError(404, "not_found", "Not found.")));
  app.use("/api/v1", api);

  // Public by design: reports status only, with no database name or version details
  app.get("/api/health", publicRoute, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await db.command({ ping: 1 });
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "Health check failed");
      res.status(503).json({ ok: false });
    }
  });

  // ---------- Pages: checked on the server before any HTML is sent ----------
  app.use(cookieParser());
  app.use(async (req, res, next) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return next(new AppError(404, "not_found", "Not found."));
      const roles = Object.hasOwn(PAGES, req.path) ? PAGES[req.path] : null;
      if (!roles) {
        return PUBLIC_PAGES.includes(req.path) || ASSET_PATH.test(req.path)
          ? next()
          : next(new AppError(404, "not_found", "Not found."));
      }

      res.setHeader("Cache-Control", "no-store");
      const auth = await sessions.load(req);
      if (!auth) return res.redirect(302, "/login.html");
      if (!roles.includes(auth.user.role)) {
        await recordEvent(db, req, {
          actor: auth.user.username, role: auth.user.role, action: "Access denied",
          details: `Tried to open ${req.path}`, severity: "warning"
        });
        return res.redirect(302, HOME[auth.user.role]);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  });
  app.use(express.static(PUBLIC_DIR, { dotfiles: "deny", redirect: false, index: "index.html" }));

  app.use((_req, _res, next) => next(new AppError(404, "not_found", "Not found.")));

  // ---------- Errors: full detail in the log, generic message to the user ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let error = err;
    if (!(err instanceof AppError)) {
      // Errors raised by Express and its body parser or static file handler
      if (err.type === "entity.too.large") error = new AppError(413, "too_large", "That request is too large.");
      else if (err.status === 400) error = new AppError(400, "invalid_input", "That request could not be read.");
      else if (err.status === 403) error = new AppError(403, "forbidden", "You do not have permission to do that.");
      else if (err.status === 404) error = new AppError(404, "not_found", "Not found.");
    }

    if (!(error instanceof AppError)) req.log.error({ err }, "Request failed");
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : "server_error";
    const message = error instanceof AppError ? error.message : `Something went wrong. Quote this reference if you report it: ${req.id}`;

    if (res.headersSent) return res.destroy();
    if (req.path.startsWith("/api/")) return res.status(status).json({ error: { code, message, requestId: req.id } });
    if (status === 404) return res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
    return res.status(status).type("text/plain").send(message);
  });

  return app;
}

module.exports = { createApp };
