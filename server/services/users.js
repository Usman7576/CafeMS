// Staff administration. Any change that creates, alters or removes an Admin needs a second Admin.
const { randomToken, hashToken } = require("../lib/crypto");
const { AppError } = require("../lib/errors");
const { recordEvent } = require("./auditLog");
const { inTransaction } = require("../lib/tx");

function createUserService({ config, db, approvals }) {
  const users = db.collection("users");
  const sessions = db.collection("sessions");
  const tokens = db.collection("auth_tokens");
  const challenges = db.collection("auth_challenges");

  // An allow-list of fields, so hashes and MFA secrets can never reach a response
  const view = (u) => ({
    username: u.username, name: u.name, role: u.role, status: u.status, lastLogin: u.lastLogin || null,
    locked: Boolean(u.lockedUntil && u.lockedUntil.getTime() > Date.now()), mfaEnabled: Boolean(u.mfa && u.mfa.enabled)
  });
  const list = async () => (await users.find().sort({ username: 1 }).toArray()).map(view);

  async function issueLink(username, purpose, createdBy, session) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + config.auth.setupTokenMs);
    await tokens.deleteMany({ username }, { session });
    await tokens.insertOne({ _id: hashToken(token), username, purpose, createdBy, expiresAt }, { session });
    // The token sits in the URL fragment, which browsers never send to servers or in Referer headers
    return { setupUrl: `${config.appOrigin}/setup.html#token=${token}`, expiresAt };
  }

  async function guardLastAdmin(target, session) {
    if (target.role !== "Admin") return;
    const others = await users.countDocuments({ role: "Admin", status: "Active", username: { $ne: target.username } }, { session });
    if (others < 1) throw new AppError(409, "last_admin", "There must always be at least one active admin.");
  }

  async function execute(req, change, session) {
    const actor = req.auth.user;
    const event = (action, details, severity = "high") => recordEvent(db, req, { actor: actor.username, role: actor.role, action, details, severity }, { session });

    if (change.action === "invite") {
      if (await users.findOne({ username: change.target }, { session })) throw new AppError(409, "username_taken", "That username is already taken.");
      await users.insertOne({
        username: change.target, name: change.name, role: change.role, status: "Invited", failedAttempts: 0, lockedUntil: null,
        createdAt: new Date(), createdBy: actor.username, mfa: { enabled: false }
      }, { session });
      await event("User invited", `${change.target} as ${change.role}`);
      return issueLink(change.target, "invitation", actor.username, session);
    }

    const target = await users.findOne({ username: change.target }, { session });
    if (!target) throw new AppError(404, "not_found", "User not found.");

    if (change.action === "reset") {
      if (target.status === "Disabled") throw new AppError(400, "disabled_account", "Enable this account before resetting it.");
      // Old credentials stop working at once, so a stolen password or phone is useless after a reset
      await users.updateOne({ username: target.username }, { $set: { mfa: { enabled: false }, failedAttempts: 0, lockedUntil: null }, $unset: { passwordHash: "" } }, { session });
      await sessions.deleteMany({ username: target.username }, { session });
      await challenges.deleteMany({ username: target.username }, { session });
      await event("Account reset", `Password and MFA reset for ${target.username}`);
      return issueLink(target.username, "reset", actor.username, session);
    }

    if (change.action === "role") {
      if (target.role !== change.role && change.role !== "Admin") await guardLastAdmin(target, session);
      await users.updateOne({ username: target.username }, { $set: { role: change.role } }, { session });
      await sessions.deleteMany({ username: target.username }, { session });
      await event("Role changed", `${target.username}: ${target.role} to ${change.role}`);
      return { username: target.username, role: change.role };
    }

    if (change.action === "status") {
      if (change.status === "Disabled") await guardLastAdmin(target, session);
      await users.updateOne({ username: target.username }, { $set: { status: change.status } }, { session });
      if (change.status === "Disabled") {
        await sessions.deleteMany({ username: target.username }, { session });
        await challenges.deleteMany({ username: target.username }, { session });
        await tokens.deleteMany({ username: target.username }, { session });
      }
      await event(change.status === "Disabled" ? "Account disabled" : "Account enabled", `${target.username} (${target.role})`);
      return { username: target.username, status: change.status };
    }
    throw new AppError(400, "invalid_input", "Unknown change.");
  }

  // Runs a change now, or sends it for approval if it touches an Admin
  async function request(req, change, summary, session) {
    const touchesAdmin = change.role === "Admin" || (await users.findOne({ username: change.target, role: "Admin" }, { session }));
    if (!touchesAdmin) return { status: change.action === "invite" || change.action === "reset" ? 201 : 200, body: await execute(req, change, session) };
    const approvalId = await approvals.create(req, "user-change", change, summary, session);
    return { status: 202, body: { approvalId, message: "A change that affects an Admin needs a second Admin to approve." } };
  }

  async function assertNotSelf(req, username) {
    if (username === req.auth.user.username) throw new AppError(400, "own_account", "Use your account page to change your own account.");
  }

  async function unlock(req, username) {
    await assertNotSelf(req, username);
    await inTransaction(db, async (session) => {
      const result = await users.updateOne({ username }, { $set: { failedAttempts: 0, lockedUntil: null } }, { session });
      if (!result.matchedCount) throw new AppError(404, "not_found", "User not found.");
      await recordEvent(db, req, { actor: req.auth.user.username, role: req.auth.user.role, action: "Account unlocked", details: username, severity: "warning" }, { session });
    });
  }

  return { list, execute, request, assertNotSelf, unlock };
}

module.exports = { createUserService };
