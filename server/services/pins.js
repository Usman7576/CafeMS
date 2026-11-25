// Checking a person's tablet PIN, shared by "switch user" and the time clock. Only floor roles have a
// PIN. Five wrong PINs pause PIN use for that person for 15 minutes, and every failure is recorded.
// The answer never says whether the person exists, has a PIN, or is paused.
const { AppError } = require("../lib/errors");
const { verifyPassword } = require("../lib/passwords");
const { PIN_ROLES } = require("../lib/permissions");
const { recordEvent } = require("./auditLog");

const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const PIN_FAILED = "That PIN is not right, or PIN sign-in is paused for this person. Try again or use your password.";

// Returns the person when the PIN is right; otherwise records the failure and throws.
// what describes the attempt for the audit log, for example "PIN switch" or "PIN clock-in".
async function checkPin(db, req, username, pin, what) {
  const users = db.collection("users");
  const from = req.auth.user;
  const target = await users.findOne({ username });
  const usable = Boolean(target && target.status === "Active" && PIN_ROLES.includes(target.role) && target.pin && target.pin.hash);
  const pinLocked = usable && Boolean(target.pin.lockedUntil) && target.pin.lockedUntil.getTime() > Date.now();
  const accountLocked = Boolean(target && target.lockedUntil && target.lockedUntil.getTime() > Date.now());
  // The hash is always checked, so the time taken reveals nothing about the person
  const ok = await verifyPassword(usable ? target.pin.hash : null, pin);
  if (!usable || pinLocked || accountLocked || !ok) {
    if (usable && !pinLocked && !ok) {
      const failures = (target.pin.failed || 0) + 1;
      const lock = failures >= PIN_MAX_FAILURES;
      await users.updateOne({ username: target.username }, { $set: { "pin.failed": lock ? 0 : failures, "pin.lockedUntil": lock ? new Date(Date.now() + PIN_LOCK_MS) : null } });
      if (lock) await recordEvent(db, req, { actor: target.username, role: target.role, action: "PIN locked", details: `${PIN_MAX_FAILURES} wrong PINs on a shared tablet`, severity: "high" });
    }
    await recordEvent(db, req, { actor: from.username, role: from.role, action: `${what} failed`, details: `For ${username}`, severity: "warning" });
    throw new AppError(401, "pin_failed", PIN_FAILED);
  }
  if (target.pin.failed) await users.updateOne({ username: target.username }, { $set: { "pin.failed": 0, "pin.lockedUntil": null } });
  return target;
}

module.exports = { checkPin, PIN_MAX_FAILURES, PIN_LOCK_MS, PIN_FAILED };
