const express = require("express");
const { z } = require("zod");
const { randomToken, hashToken, blindIndex, networkRef } = require("../lib/crypto");
const MAX_KNOWN_NETWORKS = 20;
const MAX_KNOWN_COUNTRIES = 20;
const { countryOf } = require("../lib/geo");
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
const answerSchema = z.string().trim().min(1).max(100);
// An answer to the security question goes only with a recovery code
const mfaSchema = z.object({ code: totpSchema.optional(), recoveryCode: recoverySchema.optional(), answer: answerSchema.optional() }).strict()
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode) && !(v.code && v.answer));
// A WebAuthn response, as the browser library produces it. Its contents are checked by the WebAuthn library.
const credentialSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/),
  rawId: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/),
  type: z.literal("public-key"),
  response: z.record(z.string(), z.union([z.string().max(20000), z.array(z.string().max(64)).max(10), z.number(), z.null()])),
  clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
  authenticatorAttachment: z.string().max(32).optional()
}).strict();
const passkeyResponseSchema = z.object({ response: credentialSchema }).strict();
const passkeyRegisterSchema = z.object({ response: credentialSchema, label: z.string().trim().min(1).max(60).regex(/^[^<>]*$/) }).strict();
const passkeyIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,1400}$/) }).strict();
const securityQuestionSchema = z.object({
  question: z.string().trim().min(10).max(100).regex(/^[^<>]*$/),
  answer: z.string().trim().min(3).max(100)
}).strict();
// Answers are compared without case or extra spaces, then stored only as an Argon2id hash
const normalAnswer = (answer) => String(answer).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const codeSchema = z.object({ code: totpSchema }).strict();
const setupSchema = z.object({ token: z.string().min(20).max(128), password: z.string().min(1).max(MAX_LENGTH) }).strict();
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(MAX_LENGTH), newPassword: z.string().min(1).max(MAX_LENGTH) }).strict();
const sidSchema = z.object({ sid: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/) }).strict();

function createAuthRouter({ config, db, sessions, mfa, passkeys, oidc, middleware, authLimiter }) {
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

      if (!user) {
        // A person may type a password into the username box, so an unknown name is never kept as text.
        // A keyed reference still lets repeated attempts on one name be connected.
        await audit(req, { actor: "unknown", action: "Sign-in failed", details: `Unknown username · ref ${blindIndex(username, config.blindIndexKey).slice(0, 12)}`, severity: "warning" });
        throw failed;
      }
      if (user.status !== "Active" || !user.passwordHash) {
        await audit(req, { actor: username, action: "Sign-in failed", details: "Account not active", severity: "warning" });
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

      // With a recovery code, a person who set a security question must also answer it
      const question = req.body.recoveryCode && user.securityQuestion;
      const answered = question ? Boolean(req.body.answer) && await verifyPassword(user.securityQuestion.answerHash, normalAnswer(req.body.answer)) : true;
      const ok = answered && await mfa.verifySecondFactor(user, req.body.code ? { code: req.body.code } : { recoveryCode: req.body.recoveryCode });
      if (!ok) {
        const details = req.body.code ? "Wrong or reused code" : answered ? "Wrong recovery code" : "Wrong security answer";
        await audit(req, { actor: user.username, role: user.role, action: "MFA failed", details, severity: "warning" });
        await failChallenge(challenge);
        await recordFailure(req, user);
        throw new AppError(401, "mfa_failed", CODE_FAILED);
      }
      await finishSignIn(req, res, user, challenge,
        req.body.code ? "Password and authenticator code" : question ? "Password, recovery code and security answer" : "Password and recovery code",
        req.body.code ? "info" : "high");
    } catch (error) {
      next(error);
    }
  });

  // Ends a sign-in that has passed both steps: one session, the network learned, and an audit entry
  async function finishSignIn(req, res, user, challenge, details, severity) {
      const token = await atomically(async (session) => {
        await challenges.deleteOne({ _id: challenge._id }, { session });
        const known = user.knownNetworks || [];
        const network = networkRef(req.ip, config.blindIndexKey);
        const newNetwork = !known.includes(network);
        // The country of the address, looked up locally; private and local addresses have none
        const knownCountries = user.knownCountries || [];
        const country = countryOf(req.ip);
        const newCountry = Boolean(country) && !knownCountries.includes(country);
        await users.updateOne({ username: user.username }, {
          $set: {
            failedAttempts: 0, lockedUntil: null, knownNetworks: newNetwork ? [...known, network].slice(-MAX_KNOWN_NETWORKS) : known,
            knownCountries: newCountry ? [...knownCountries, country].slice(-MAX_KNOWN_COUNTRIES) : knownCountries
          }
        }, { session });
        if (newCountry && knownCountries.length) await audit(req, { actor: user.username, role: user.role, action: "Sign-in from a new country", details: `${country}, not seen before for this account`, severity: "high" }, session);
        const issued = await sessions.create(user, req, session);
        // A person's first network is simply learned. Later ones are worth a look.
        if (newNetwork && known.length) await audit(req, { actor: user.username, role: user.role, action: "Sign-in from a new network", details: "Not seen before for this account", severity: "warning" }, session);
        await audit(req, { actor: user.username, role: user.role, action: "Signed in", details, severity }, session);
        return issued;
      });
      sessions.setCookie(res, token);
      res.json({ username: user.username, name: user.name, role: user.role });
  }

  // The question is shown only after the password step, so it reveals nothing about other accounts
  router.get("/mfa/security-question", publicRoute, async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "mfa");
      const user = await users.findOne({ username: challenge.username });
      res.json({ question: user && user.securityQuestion ? user.securityQuestion.question : null });
    } catch (error) {
      next(error);
    }
  });

  // ---------- First step with an organisation account (OpenID Connect) ----------
  const OIDC_COOKIE = "__Host-cms_oidc";
  // Lax, because the provider sends the browser back with a top-level navigation from its own site
  const oidcCookie = { ...cookieOptions(10 * 60 * 1000), sameSite: "lax" };
  router.get("/oidc/enabled", publicRoute, (_req, res) => res.json({ enabled: oidc.enabled() }));
  router.get("/oidc/start", publicRoute, authLimiter, async (req, res, next) => {
    try {
      const { url, state } = await oidc.start("signin");
      res.cookie(OIDC_COOKIE, state, oidcCookie);
      res.redirect(302, url);
    } catch (error) {
      next(error);
    }
  });
  // Linking is done by the signed-in person after a fresh check, so nobody can attach their own
  // organisation account to someone else's staff account
  router.post("/oidc/link", requireAuth, requireStepUp, async (req, res, next) => {
    try {
      const { url, state } = await oidc.start("link", req.auth.user.username);
      res.cookie(OIDC_COOKIE, state, oidcCookie);
      res.json({ url });
    } catch (error) {
      next(error);
    }
  });
  router.post("/oidc/unlink", requireAuth, requireStepUp, async (req, res, next) => {
    try {
      const { user } = req.auth;
      await atomically(async (session) => {
        await users.updateOne({ username: user.username }, { $unset: { oidc: "" } }, { session });
        await audit(req, { actor: user.username, role: user.role, action: "Organisation account unlinked", details: "OpenID Connect", severity: "warning" }, session);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.get("/oidc/callback", publicRoute, authLimiter, async (req, res, next) => {
    const cookieState = req.cookies && req.cookies[OIDC_COOKIE];
    res.clearCookie(OIDC_COOKIE, oidcCookie);
    try {
      const result = await oidc.finish(new URL(req.originalUrl, config.appOrigin), cookieState);
      if (result.mode === "link") {
        const taken = await users.findOne({ "oidc.iss": result.identity.iss, "oidc.sub": result.identity.sub });
        if (taken && taken.username !== result.username) throw new AppError(409, "oidc_failed", "That organisation account is already linked to another person.");
        await atomically(async (session) => {
          await users.updateOne({ username: result.username }, { $set: { oidc: { ...result.identity, linkedAt: new Date() } } }, { session });
          await audit(req, { actor: result.username, action: "Organisation account linked", details: result.identity.iss, severity: "warning" }, session);
        });
        return res.redirect(302, "/account.html#oidc-linked");
      }
      const user = await users.findOne({ "oidc.iss": result.identity.iss, "oidc.sub": result.identity.sub });
      if (!user || user.status !== "Active" || isLocked(user)) {
        await audit(req, { actor: user ? user.username : "unknown", action: "Sign-in failed", details: "Organisation account not linked or not allowed", severity: "warning" });
        return res.redirect(302, "/login.html#oidc-failed");
      }
      // The organisation account stands in for the password; the cafe's own second factor still follows
      await audit(req, { actor: user.username, role: user.role, action: "Organisation account accepted", details: "First step of sign-in", severity: "info" });
      await startChallenge(res, user.username, user.mfa && user.mfa.enabled ? "mfa" : "enroll");
      return res.redirect(302, user.mfa && user.mfa.enabled ? "/login.html#mfa" : "/login.html#enroll");
    } catch (error) {
      if (error.code === "oidc_failed") return res.redirect(302, "/login.html#oidc-failed");
      return next(error);
    }
  });

  // ---------- Second step with a passkey (fingerprint, face or PIN) ----------
  router.post("/mfa/passkey/options", publicRoute, authLimiter, async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "mfa");
      res.json(await passkeys.authenticationOptions(challenge.username, "login", challenge._id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/mfa/passkey", publicRoute, authLimiter, validate(passkeyResponseSchema), async (req, res, next) => {
    try {
      const challenge = await loadChallenge(req, "mfa");
      const user = await users.findOne({ username: challenge.username });
      if (!user || user.status !== "Active" || isLocked(user)) {
        await challenges.deleteOne({ _id: challenge._id });
        throw new AppError(401, "challenge_expired", "Your sign-in has expired. Please start again.");
      }
      if (!(await passkeys.authenticate(user.username, "login", challenge._id, req.body.response))) {
        await audit(req, { actor: user.username, role: user.role, action: "MFA failed", details: "Passkey not accepted", severity: "warning" });
        await failChallenge(challenge);
        await recordFailure(req, user);
        throw new AppError(401, "passkey_failed", "That passkey was not accepted. Try again or use your authenticator code.");
      }
      await finishSignIn(req, res, user, challenge, "Password and passkey", "info");
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
        const known = current.knownNetworks || [];
        const network = networkRef(req.ip, config.blindIndexKey);
        await users.updateOne({ username: current.username }, {
          $set: { failedAttempts: 0, lockedUntil: null, knownNetworks: known.includes(network) ? known : [...known, network].slice(-MAX_KNOWN_NETWORKS) }
        }, { session });
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
      // Tells the browser to drop any copies of pages it cached for this person. Storage is not
      // listed, because the browser's own signing key is kept for the next sign-in on this device.
      res.set("Clear-Site-Data", "\"cache\"");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post("/step-up", requireAuth, authLimiter, validate(codeSchema), async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      if (isLocked(user)) throw new AppError(401, "mfa_failed", CODE_FAILED);
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

  // A passkey can confirm a sensitive action instead of a typed code
  router.post("/step-up/passkey/options", requireAuth, async (req, res, next) => {
    try {
      res.json(await passkeys.authenticationOptions(req.auth.user.username, "step-up", req.auth.session.sid));
    } catch (error) {
      next(error);
    }
  });
  router.post("/step-up/passkey", requireAuth, authLimiter, validate(passkeyResponseSchema), async (req, res, next) => {
    try {
      const { user, session } = req.auth;
      if (isLocked(user) || !(await passkeys.authenticate(user.username, "step-up", session.sid, req.body.response))) {
        await audit(req, { actor: user.username, role: user.role, action: "MFA failed", details: "Step-up passkey rejected", severity: "warning" });
        await recordFailure(req, user);
        throw new AppError(401, "passkey_failed", "That passkey was not accepted. Try again or use your authenticator code.");
      }
      await atomically(async (txn) => {
        await db.collection("sessions").updateOne({ jti: session.jti }, { $set: { stepUpAt: new Date() } }, { session: txn });
        await audit(req, { actor: user.username, role: user.role, action: "Authenticator re-check passed", details: "Passkey, for a sensitive action" }, txn);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // ---------- Managing passkeys ----------
  // Adding one needs the same freshness as other changes to how a person signs in
  const freshlyVerified = (session) => {
    const now = Date.now();
    return (session.stepUpAt && now - session.stepUpAt.getTime() <= config.auth.stepUpMs) || now - session.createdAt.getTime() <= config.auth.stepUpMs;
  };
  router.post("/passkeys/register/options", requireAuth, async (req, res, next) => {
    try {
      if (!freshlyVerified(req.auth.session)) throw new AppError(403, "step_up_required", "Confirm your authenticator code to continue.");
      res.json(await passkeys.registrationOptions(req.auth.user, req.auth.session.sid));
    } catch (error) {
      next(error);
    }
  });
  router.post("/passkeys", requireAuth, validate(passkeyRegisterSchema), async (req, res, next) => {
    try {
      if (!freshlyVerified(req.auth.session)) throw new AppError(403, "step_up_required", "Confirm your authenticator code to continue.");
      res.status(201).json(await passkeys.register(req, req.auth.session.sid, req.body.response, req.body.label));
    } catch (error) {
      next(error);
    }
  });
  router.get("/passkeys", requireAuth, async (req, res, next) => {
    try {
      res.json({ passkeys: await passkeys.list(req.auth.user.username) });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/passkeys/:id", requireAuth, requireStepUp, validate(passkeyIdSchema, "params"), async (req, res, next) => {
    try {
      await passkeys.remove(req, req.params.id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // ---------- Security question, asked with a recovery code ----------
  router.get("/security-question", requireAuth, async (req, res, next) => {
    try {
      const user = await users.findOne({ username: req.auth.user.username });
      res.json({ question: user.securityQuestion ? user.securityQuestion.question : null });
    } catch (error) {
      next(error);
    }
  });
  router.post("/security-question", requireAuth, requireStepUp, validate(securityQuestionSchema), async (req, res, next) => {
    try {
      const { user } = req.auth;
      const answerHash = await hashPassword(normalAnswer(req.body.answer));
      await atomically(async (session) => {
        await users.updateOne({ username: user.username }, { $set: { securityQuestion: { question: req.body.question, answerHash, setAt: new Date() } } }, { session });
        await audit(req, { actor: user.username, role: user.role, action: "Security question set", details: "Asked when a recovery code is used", severity: "warning" }, session);
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
      if (isLocked(user)) throw new AppError(401, "sign_in_failed", "Your current password is not correct.");
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

  // ---------- Personal signing keys (non-repudiation) ----------
  const signingKeySchema = z.object({
    publicKey: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
    label: z.string().trim().min(1).max(60).regex(/^[^<>]*$/)
  }).strict();
  const keyIdSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict();
  router.post("/signing-keys", requireAuth, validate(signingKeySchema), async (req, res, next) => {
    try {
      res.status(201).json(await middleware.signatures.register(req, req.body));
    } catch (error) {
      next(error);
    }
  });
  router.get("/signing-keys", requireAuth, async (req, res, next) => {
    try {
      res.json({ keys: await middleware.signatures.list(req.auth.user.username) });
    } catch (error) {
      next(error);
    }
  });
  router.delete("/signing-keys/:id", requireAuth, validate(keyIdSchema, "params"), async (req, res, next) => {
    try {
      await middleware.signatures.revoke(req, req.params.id);
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
        sessions: list.map((s) => ({ id: s.sid, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, country: countryOf(s.ip), userAgent: s.userAgent, current: s.jti === session.jti }))
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
