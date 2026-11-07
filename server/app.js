const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
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
const { createBusinessRouter } = require("./routes/business");
const { createCatalogService } = require("./services/catalog");
const { createOrderService } = require("./services/orders");
const { createApprovalService } = require("./services/approvals");
const { createBillingService } = require("./services/billing");
const { createReservationService } = require("./services/reservations");
const { createUserService } = require("./services/users");
const { createAlertService } = require("./services/alerts");
const { createCustomerService } = require("./services/customers");
const { createPhotoService } = require("./services/photos");
const { createCafeService } = require("./services/cafe");
const { createRiskService } = require("./services/riskRegister");
const { createPublicRouter } = require("./routes/public");
const { createSimulatedGateway, verifyCallback } = require("./services/gateway");
const { bindAudit, recordEvent: audit } = require("./services/auditLog");
const schemas = require("./lib/schemas");
const { hashToken } = require("./lib/crypto");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Only these asset folders are served. Everything else not listed as a page is a 404 (default deny).
const ASSET_PATH = /^\/(?:css|js|assets|fonts|vendor)\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9]+)+$/;

function createApp({ config, db, logger, gateway = createSimulatedGateway() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  bindAudit(db, config);
  const sessions = createSessionService(config, db);
  const mfa = createMfaService(config, db);
  const userLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.limits.userPerMinute,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.auth.user.username}`,
    handler: (_req, _res, next) => next(new AppError(429, "rate_limited", "Too many requests. Please wait a moment."))
  });
  const middleware = createAuthMiddleware(config, db, sessions, { userLimiter });

  const catalog = createCatalogService({ db });
  const approvals = createApprovalService({ db });
  const orderService = createOrderService({ db, catalog });
  const billing = createBillingService({ config, db, orderService, approvals, gateway, logger });
  const reservations = createReservationService({ config, db });
  const userService = createUserService({ config, db, approvals });
  const alerts = createAlertService({ db, logger });
  const customers = createCustomerService({ config, db });
  const photos = createPhotoService({ config, db });
  const cafe = createCafeService({ db });
  const risk = createRiskService();
  const services = { catalog, approvals, orderService, billing, reservations, userService, alerts, customers, photos, cafe, risk };

  approvals.register("refund", {
    approve: (req, approval, session) => billing.applyRefund(req, approval.payload.no, approval.payload.reason, approval.requestedBy, session),
    reject: (_req, approval, session) => db.collection("bills").updateOne({ _id: approval.payload.no }, { $unset: { refundPending: "" } }, { session })
  });
  approvals.register("user-change", {
    approve: (req, approval, session) => userService.execute(req, approval.payload, session)
  });

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url.startsWith("/assets/") } }));
  app.use(securityHeaders(config));
  app.use(permissionsPolicy);

  // ---------- API ----------
  const api = express.Router();
  api.use(noStore);
  api.use(limiter(60 * 1000, config.limits.apiPerMinute, "Too many requests. Please wait a moment."));
  api.use(express.json({ limit: config.limits.jsonBody, strict: true }));

  // Only failures count, so staff signing in from one shared cafe network do not lock each other out
  const authLimiter = limiter(15 * 60 * 1000, config.limits.authPer15Minutes, "Too many attempts. Please wait a few minutes and try again.", { skipSuccessfulRequests: true });

  // The gateway calls this from its own server, so it has no browser Origin or session.
  // Its HMAC signature, timestamp and the stored amount are what is checked instead.
  api.post("/payments/callback", publicRoute, authLimiter, async (req, res, next) => {
    try {
      const parsed = schemas.gatewayCallback.safeParse(req.body);
      const valid = parsed.success && verifyCallback(config.gateway.secret, req.get("x-gateway-timestamp"), req.get("x-gateway-signature"), parsed.data);
      if (!valid) {
        await audit(db, req, { actor: "payment-gateway", action: "Gateway callback refused", details: "Bad signature, old timestamp or bad data", severity: "high" });
        throw new AppError(401, "bad_signature", "This callback was refused.");
      }
      // Each signed callback is accepted once. A copy sent again within the time window is refused.
      try {
        await db.collection("gateway_callbacks").insertOne({ _id: hashToken(req.get("x-gateway-signature")), reference: parsed.data.reference, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
      } catch (error) {
        if (error.code !== 11000) throw error;
        await audit(db, req, { actor: "payment-gateway", action: "Gateway callback replayed", details: parsed.data.reference, severity: "high" });
        throw new AppError(409, "replayed", "This callback was already received.");
      }
      await billing.recordGatewayResult(req, parsed.data.reference, parsed.data, "payment-gateway");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  api.use(originCheck(config));
  api.use(cookieParser());

  api.use("/auth", createAuthRouter({ config, db, sessions, mfa, middleware, authLimiter }));
  // Limits one person's sensitive reads, such as bulk exports (keyed by user, not by address)
  const personalLimiter = (name, perHour) => rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: perHour,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:${req.auth.user.username}`,
    handler: (_req, _res, next) => next(new AppError(429, "rate_limited", "You have reached the hourly limit for this action."))
  });
  api.use("/public", createPublicRouter({ config, services }));
  api.use("/users", createUsersRouter({ db, middleware, services }));
  api.use(createBusinessRouter({ db, middleware, services, personalLimiter, photoLimit: config.limits.photoBody }));
  api.use((_req, _res, next) => next(new AppError(404, "not_found", "Not found.")));
  app.use("/api/v1", api);

  // Everything outside the API has its own limit, so health checks and page requests cannot be used
  // to flood the database or the audit log
  app.use(limiter(60 * 1000, config.limits.sitePerMinute, "Too many requests. Please wait a moment."));

  // Liveness: the process is running. Readiness: it can also reach the database.
  // Public by design: they report status only, with no database name or version details.
  app.get("/api/health/live", publicRoute, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });
  app.get(["/api/health", "/api/health/ready"], publicRoute, async (_req, res) => {
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
