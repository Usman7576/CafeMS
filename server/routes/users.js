const express = require("express");
const { z } = require("zod");
const { randomToken, hashToken } = require("../lib/crypto");
const { AppError } = require("../lib/errors");
const { validate } = require("../middleware/auth");
const { recordEvent } = require("../services/auditLog");

const USERNAME = /^[a-z][a-z0-9._]{2,29}$/;
const usernameParams = z.object({ username: z.string().regex(USERNAME) }).strict();
const invitationSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME),
  name: z.string().trim().min(2).max(60),
  role: z.enum(["Waiter", "Kitchen", "Cashier", "Manager", "Admin"])
}).strict();

function createUsersRouter({ config, db, sessions, middleware }) {
  const router = express.Router();
  const users = db.collection("users");
  const tokens = db.collection("auth_tokens");
  const { requireAuth, requirePermission, requireStepUp } = middleware;
  const adminOnly = [requireAuth, requirePermission("users.manage"), requireStepUp];

  async function issueLink(username, purpose, createdBy) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + config.auth.setupTokenMs);
    await tokens.deleteMany({ username });
    await tokens.insertOne({ _id: hashToken(token), username, purpose, createdBy, expiresAt });
    // The token sits in the URL fragment, which browsers never send to servers or in Referer headers
    return { setupUrl: `${config.appOrigin}/setup.html#token=${token}`, expiresAt };
  }

  async function findTarget(req) {
    const target = await users.findOne({ username: req.validParams.username });
    if (!target) throw new AppError(404, "not_found", "User not found.");
    if (target.username === req.auth.user.username) throw new AppError(400, "own_account", "Use your account page to change your own account.");
    return target;
  }

  router.post("/invitations", ...adminOnly, validate(invitationSchema), async (req, res, next) => {
    try {
      const { username, name, role } = req.body;
      // Separation of privilege: granting Admin needs a second Admin. Until that approval flow
      // arrives in Phase 2, this request is refused rather than allowed by one person.
      if (role === "Admin") throw new AppError(403, "second_admin_required", "Granting the Admin role needs a second Admin to approve.");
      if (await users.findOne({ username })) throw new AppError(409, "username_taken", "That username is already taken.");
      await users.insertOne({ username, name, role, status: "Invited", failedAttempts: 0, lockedUntil: null, createdAt: new Date(), createdBy: req.auth.user.username, mfa: { enabled: false } });
      const link = await issueLink(username, "invitation", req.auth.user.username);
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "User invited", details: `${username} as ${role}`, severity: "high" });
      res.status(201).json(link);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:username/reset-link", ...adminOnly, validate(usernameParams, "params"), async (req, res, next) => {
    try {
      const target = await findTarget(req);
      if (target.status === "Disabled") throw new AppError(400, "disabled_account", "Enable this account before resetting it.");
      // Old credentials stop working at once, so a stolen password or phone is useless after a reset
      await users.updateOne({ username: target.username }, { $set: { mfa: { enabled: false }, failedAttempts: 0, lockedUntil: null }, $unset: { passwordHash: "" } });
      await sessions.revokeAll(target.username);
      const link = await issueLink(target.username, "reset", req.auth.user.username);
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Account reset", details: `Password and MFA reset for ${target.username}`, severity: "high" });
      res.status(201).json(link);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:username/unlock", ...adminOnly, validate(usernameParams, "params"), async (req, res, next) => {
    try {
      const target = await findTarget(req);
      await users.updateOne({ username: target.username }, { $set: { failedAttempts: 0, lockedUntil: null } });
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Account unlocked", details: target.username, severity: "warning" });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createUsersRouter };
