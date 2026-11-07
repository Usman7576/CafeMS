const express = require("express");
const { z } = require("zod");
const { randomToken, hashToken } = require("../lib/crypto");
const { hashPassword, verifyPassword, dummyVerify, passwordProblems, MAX_LENGTH } = require("../lib/passwords");
const { AppError, invalidInput } = require("../lib/errors");
const { publicRoute, validate } = require("../middleware/auth");
const { recordEvent } = require("../services/auditLog");
const { inTransaction } = require("../lib/tx");
const { cookieOptions, PREAUTH_COOKIE } = require("../services/sessions");

// One message for every sign-in failure, so it never reveals whether an account exists or is locked
const SIGN_IN_FAILED = "Incorrect username or password, or the account is temporarily locked.";
const CODE_FAILED = "That code is not valid. Check your authenticator app and try again.";

const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(MAX_LENGTH)
}).strict();
const totpSchema = z.string().regex(/^\d{6}$/);
const recoverySchema = z.string().regex(/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/);
const mfaSchema = z.object({ code: totpSchema.optional(), recoveryCode: recoverySchema.optional() }).strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode));
const codeSchema = z.object({ code: totpSchema }).strict();
const setupSchema = z.object({ token: z.string().min(20).max(128), password: z.string().min(1).max(MAX_LENGTH) }).strict();
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(MAX_LENGTH), newPassword: z.string().min(1).max(MAX_LENGTH) }).strict();
const sidSchema = z.object({ sid: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/) }).strict();

function createAuthRouter({ config, db, sessions, mfa, middleware, authLimiter }) {
  const router = express.Router();
  const users = db.collection("users");
  const challenges = db.collection("auth_challenges");
  const tokens = db.collection("auth_tokens");
  const { requireAuth, requireStepUp } = middleware;

  // With a transaction, the entry commits or fails together with the change it records
  const audit = (req, event, session) => recordEvent(db, req, event, session ? { session } : {});
  const atomically = (work) => inTransaction(db, work);

  // Hash once at start-up, so the first unknown-username sign-in is not slower than the rest
  dummyVerify("warm-up").catch(() => {});

  async function recordFailure(req, user) {
    const updated = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { failedAttempts: 1 } },
      { returnDocument: "after" }
    );
    if (updated && updated.failedAttempts >= config.auth.maxFailedAttempts) {
      await atomically(async (session) => {
        await users.updateOne(
          { username: user.username },
          { $set: { lockedUntil: new Date(Date.now() + config.auth.lockMs), failedAttempts: 0 } },
          { session }
        );
        await audit(req, { actor: user.username, role: user.role, action: "Account locked", details: `${config.auth.maxFailedAttempts} failed attempts`, severity: "high" }, session);
      });
    }
  }

  function isLocked(user) {
    return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
  }

  async function startChallenge(res, username, stage, extra = {}) {
    const token = randomToken(32);
    await challenges.insertOne({ _id: hashToken(token), username, stage, attempts: 0, expiresAt: new Date(Date.now() + config.auth.challengeMs), ...extra });
    res.cookie(PREAUTH_COOKIE, token, cookieOptions(config.auth.challengeMs));
  }

  async function loadChallenge(req, stage) {
    const token = req.cookies && req.cookies[PREAUTH_COOKIE];
    if (typeof token !== "string") throw new AppError(401, "challenge_expired", "Your sign-in has expired. Please start again.");
    const challenge = await challenges.findOne({ _id: hashToken(token) });
    if (!challenge || challenge.stage !== stage || challenge.expiresAt.getTime() <= Date.now()) {
      throw new AppError(401, "challenge_expired", "Your sign-in has expired. Please start again.");
    }
    return challenge;
  }

  async function failChallenge(challenge) {
    const updated = await challenges.findOneAndUpdate({ _id: challenge._id }, { $inc: { attempts: 1 } }, { returnDocument: "after" });
    if (!updated || updated.attempts >= config.auth.challengeMaxAttempts) await challenges.deleteOne({ _id: challenge._id });
  }

  // ---------- Step 1: password ----------
  router.post("/login", publicRoute, authLimiter, async (req, res, next) => {
    try {
      const failed = new AppError(401, "sign_in_failed", SIGN_IN_FAILED);
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        await dummyVerify("invalid-input");
        await audit(req, { actor: "unknown", action: "Sign-in failed", details: "Malformed sign-in request", severity: "warning" });
        throw failed;
      }
      const { username, password } = parsed.data;
      const user = await users.findOne({ username });

      // The hash is always checked, even for a locked or unknown account, so timing reveals nothing
      const passwordOk = await verifyPassword(user ? user.passwordHash : null, password);

      if (!user || user.status !== "Active" || !user.passwordHash) {
        await audit(req, { actor: username, action: "Sign-in failed", details: user ? "Account not active" : "Unknown username", severity: "warning" });
        throw failed;
      }
      if (isLocked(user)) {
        await audit(req, { actor: username, role: user.role, action: "Sign-in failed", details: "Account is locked", severity: "warning" });
        throw failed;
      }
      if (!passwordOk) {
        await audit(req, { actor: username, role: user.role, action: "Sign-in failed", details: "Wrong password", severity: "warning" });
        await recordFailure(req, user);
        throw failed;
      }

      // The failure count is cleared only after the second factor succeeds. Clearing it here would let
      // someone who knows the password keep guessing authenticator codes without ever being locked out.
      const stage = user.mfa && user.mfa.enabled ? "mfa" : "enroll";
      await startChallenge(res, username, stage);
      res.json({ next: stage });
    } catch (error) {
      next(error);
    }
  });

  // ---------- Step 2: authenticator or recovery code ----------
  router.post("/mfa/verify", publicRoute, authLimiter, validate(mfaSchema), async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "mfa");
      const user = await users.findOne({ username: challenge.username });
      if (!user || user.status !== "Active" || isLocked(user)) {
        await challenges.deleteOne({ _id: challenge._id });
        throw new AppError(401, "challenge_expired", "Your sign-in has expired. Please start again.");
      }

      const ok = req.body.code
        ? await mfa.verifyCode(user, req.body.code)
        : await mfa.verifyRecoveryCode(user, req.body.recoveryCode);
      if (!ok) {
        await audit(req, { actor: user.username, role: user.role, action: "MFA failed", details: req.body.code ? "Wrong or reused code" : "Wrong recovery code", severity: "warning" });
        await failChallenge(challenge);
        await recordFailure(req, user);
        throw new AppError(401, "mfa_failed", CODE_FAILED);
      }

      const token = await atomically(async (session) => {
        await challenges.deleteOne({ _id: challenge._id }, { session });
        await users.updateOne({ username: user.username }, { $set: { failedAttempts: 0, lockedUntil: null } }, { session });
        const issued = await sessions.create(user, req, session);
        await audit(req, {
          actor: user.username, role: user.role, action: "Signed in",
          details: req.body.code ? "Password and authenticator code" : "Password and recovery code",
          severity: req.body.code ? "info" : "high"
        }, session);
        return issued;
      });
      sessions.setCookie(res, token);
      res.json({ username: user.username, name: user.name, role: user.role });
    } catch (error) {
      next(error);
    }
  });

  // ---------- First sign-in: enrol an authenticator ----------
  router.post("/mfa/enroll/start", publicRoute, authLimiter, async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "enroll");
      const enrolment = await mfa.beginEnrolment(challenge.username);
      await challenges.updateOne({ _id: challenge._id }, { $set: { pendingSecretEnc: enrolment.secretEnc } });
      res.json({ qrDataUrl: enrolment.qrDataUrl, manualKey: enrolment.manualKey });
    } catch (error) {
      next(error);
    }
  });

  router.post("/mfa/enroll/confirm", publicRoute, authLimiter, validate(codeSchema), async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "enroll");
      if (!challenge.pendingSecretEnc) throw invalidInput();
      const current = await users.findOne({ username: challenge.username });
      if (!current || current.status !== "Active" || !current.passwordHash) {
        await challenges.deleteOne({ _id: challenge._id });
        throw new AppError(401, "challenge_expired", "Your sign-in has expired. Please start again.");
      }
      const done = await atomically(async (session) => {
        const recoveryCodes = await mfa.completeEnrolment(challenge.username, challenge.pendingSecretEnc, req.body.code, session);
        if (!recoveryCodes) return null;
        await challenges.deleteOne({ _id: challenge._id }, { session });
        await users.updateOne({ username: current.username }, { $set: { failedAttempts: 0, lockedUntil: null } }, { session });
        const token = await sessions.create(current, req, session);
        await audit(req, { actor: current.username, role: current.role, action: "MFA enrolled", details: "Authenticator added", severity: "warning" }, session);
        return { token, recoveryCodes };
      });
      if (!done) {
        await failChallenge(challenge);
        throw new AppError(401, "mfa_failed", CODE_FAILED);
      }
      sessions.setCookie(res, done.token);
      res.json({ username: current.username, name: current.name, role: current.role, recoveryCodes: done.recoveryCodes });
    } catch (error) {
      next(error);
    }
  });

  // ---------- Invitation or reset link: set a password, then enrol MFA ----------
  router.post("/setup", publicRoute, authLimiter, validate(setupSchema), async (req, res, next) => {
    try {
      const failed = new AppError(400, "bad_setup_link", "This link is invalid or has expired. Ask an Admin for a new one.");
      const tokenHash = hashToken(req.body.token);
      const record = await tokens.findOne({ _id: tokenHash });
      if (!record || record.expiresAt.getTime() <= Date.now()) throw failed;
      const user = await users.findOne({ username: record.username });
      if (!user || user.status === "Disabled") throw failed;

      const problems = passwordProblems(req.body.password, user.username);
      if (problems.length) throw new AppError(400, "weak_password", problems.join(" "));
      const passwordHash = await hashPassword(req.body.password);

      await atomically(async (session) => {
        // Deleting the token first makes it single-use, even if two requests race
        const claimed = await tokens.findOneAndDelete({ _id: tokenHash }, { session });
        if (!claimed) throw failed;
        await users.updateOne({ username: user.username }, {
          $set: { passwordHash, status: "Active", passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null, mfa: { enabled: false } }
        }, { session });
        await sessions.revokeAll(user.username, session);
        await challenges.deleteMany({ username: user.username }, { session });
        await audit(req, { actor: user.username, role: user.role, action: "Password set", details: `Used ${record.purpose} link`, severity: "warning" }, session);
      });
      await startChallenge(res, user.username, "enroll");
      res.json({ next: "enroll" });
    } catch (error) {
      next(error);
    }
  });

  // ---------- Signed-in actions ----------
  router.get("/me", requireAuth, (req, res) => {
    const { user, session } = req.auth;
    res.json({
      username: user.username, name: user.name, role: user.role,
      loginAt: session.createdAt, csrfToken: session.csrfToken, idleSeconds: Math.floor(config.auth.sessionIdleMs / 1000),
      recoveryCodesLeft: user.mfa && user.mfa.recoveryHashes ? user.mfa.recoveryHashes.length : 0
    });
  });

  // The browser reports real user activity, so a person reading a screen stays signed in
  router.post("/heartbeat", requireAuth, (_req, res) => res.status(204).end());

  router.post("/logout", requireAuth, async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      await atomically(async (txn) => {
        await sessions.revoke(session.jti, null, txn);
        await audit(req, { actor: user.username, role: user.role, action: "Signed out", details: "User signed out" }, txn);
      });
      await sessions.revoke(session.jti, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/step-up", requireAuth, authLimiter, validate(codeSchema), async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      if (!(await mfa.verifyCode(user, req.body.code))) {
        await audit(req, { actor: user.username, role: user.role, action: "MFA failed", details: "Step-up code rejected", severity: "warning" });
        await recordFailure(req, user);
        throw new AppError(401, "mfa_failed", CODE_FAILED);
      }
      await atomically(async (txn) => {
        await db.collection("sessions").updateOne({ jti: session.jti }, { $set: { stepUpAt: new Date() } }, { session: txn });
        await audit(req, { actor: user.username, role: user.role, action: "Authenticator re-check passed", details: "For a sensitive action" }, txn);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/mfa/recovery-codes", requireAuth, requireStepUp, async (req, res, next) => {
    try {
      const { user } = req.auth;
      const recoveryCodes = await atomically(async (session) => {
        const codes = await mfa.replaceRecoveryCodes(user.username, session);
        await audit(req, { actor: user.username, role: user.role, action: "Recovery codes replaced", details: "Old codes cancelled", severity: "warning" }, session);
        return codes;
      });
      res.json({ recoveryCodes });
    } catch (error) {
      next(error);
    }
  });

  router.post("/password", requireAuth, authLimiter, validate(changePasswordSchema), async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        await audit(req, { actor: user.username, role: user.role, action: "Password change failed", details: "Wrong current password", severity: "warning" });
        await recordFailure(req, user);
        throw new AppError(401, "sign_in_failed", "Your current password is not correct.");
      }
      const problems = passwordProblems(req.body.newPassword, user.username);
      if (problems.length) throw new AppError(400, "weak_password", problems.join(" "));
      const passwordHash = await hashPassword(req.body.newPassword);
      await atomically(async (txn) => {
        await users.updateOne({ username: user.username }, { $set: { passwordHash, passwordChangedAt: new Date() } }, { session: txn });
        await db.collection("sessions").deleteMany({ username: user.username, jti: { $ne: session.jti } }, { session: txn });
        await challenges.deleteMany({ username: user.username }, { session: txn });
        await audit(req, { actor: user.username, role: user.role, action: "Password changed", details: "Other sessions ended", severity: "warning" }, txn);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions", requireAuth, async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      const all = await db.collection("sessions").find({ username: user.username }).sort({ lastSeenAt: -1 }).toArray();
      const list = all.filter((s) => sessions.isLive(s));
      const dead = all.filter((s) => !sessions.isLive(s)).map((s) => s.jti);
      if (dead.length) await db.collection("sessions").deleteMany({ jti: { $in: dead } });
      res.json({
        sessions: list.map((s) => ({ id: s.sid, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: s.jti === session.jti }))
      });
    } catch (error) {
      next(error);
    }
  });

  // The username filter is the ownership check: another person's session ID simply matches nothing
  router.delete("/sessions/:sid", requireAuth, validate(sidSchema, "params"), async (req, res, next) => {
    try {
      const { user } = req.auth;
      await atomically(async (session) => {
        const result = await db.collection("sessions").deleteOne({ sid: req.validParams.sid, username: user.username }, { session });
        if (!result.deletedCount) throw new AppError(404, "not_found", "That session no longer exists.");
        await audit(req, { actor: user.username, role: user.role, action: "Session revoked", details: "Revoked from device list", severity: "warning" }, session);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
