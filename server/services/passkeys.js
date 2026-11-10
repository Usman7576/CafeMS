// Passkeys (WebAuthn): the device proves who is there with a fingerprint, face or PIN, then signs a
// one-time challenge for this site only. That makes them biometric and resistant to phishing, because
// a look-alike site gets a signature for the wrong origin, which is refused.
const crypto = require("crypto");
const {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse
} = require("@simplewebauthn/server");
const { AppError } = require("../lib/errors");
const { recordEvent } = require("./auditLog");

const CHALLENGE_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const notAccepted = () => new AppError(401, "passkey_failed", "That passkey was not accepted. Try again or use your authenticator code.");

function createPasskeyService({ config, db }) {
  const passkeys = db.collection("passkeys");
  const challenges = db.collection("passkey_challenges");
  const rpID = new URL(config.appOrigin).hostname;
  const expectedOrigin = config.appOrigin;

  // One challenge at a time per purpose and owner (a session or a sign-in in progress); it works once
  async function keepChallenge(key, challenge) {
    await challenges.updateOne({ _id: key }, { $set: { challenge, expiresAt: new Date(Date.now() + CHALLENGE_MS) } }, { upsert: true });
  }
  async function takeChallenge(key) {
    const found = await challenges.findOneAndDelete({ _id: key });
    if (!found || found.expiresAt.getTime() <= Date.now()) throw notAccepted();
    return found.challenge;
  }
  const ownedBy = (username) => passkeys.find({ username }).sort({ createdAt: 1 }).toArray();

  async function registrationOptions(user, owner) {
    const existing = await ownedBy(user.username);
    if (existing.length >= MAX_PASSKEYS) throw new AppError(409, "too_many_passkeys", `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
    const options = await generateRegistrationOptions({
      rpName: "CafeMS", rpID, userName: user.username, userDisplayName: user.name,
      userID: crypto.createHash("sha256").update(`passkey-user:${user.username}`).digest(),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p._id, transports: p.transports })),
      // The fingerprint, face or PIN check on the device is required, not optional
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
    });
    await keepChallenge(`register:${owner}`, options.challenge);
    return options;
  }

  async function register(req, owner, response, label) {
    const { user } = req.auth;
    const expectedChallenge = await takeChallenge(`register:${owner}`);
    let result;
    try {
      result = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true });
    } catch {
      throw notAccepted();
    }
    if (!result.verified) throw notAccepted();
    const { credential } = result.registrationInfo;
    await passkeys.insertOne({
      _id: credential.id, username: user.username, label, publicKey: Buffer.from(credential.publicKey), counter: credential.counter,
      transports: credential.transports || [], createdAt: new Date(), lastUsedAt: null
    });
    await recordEvent(db, req, { actor: user.username, role: user.role, action: "Passkey added", details: label, severity: "warning" });
    return { id: credential.id };
  }

  async function authenticationOptions(username, purpose, owner) {
    const mine = await ownedBy(username);
    if (!mine.length) throw new AppError(404, "no_passkey", "There is no passkey on this account yet.");
    const options = await generateAuthenticationOptions({
      rpID, userVerification: "required",
      allowCredentials: mine.map((p) => ({ id: p._id, transports: p.transports }))
    });
    await keepChallenge(`${purpose}:${owner}`, options.challenge);
    return options;
  }

  // True only if this person's own passkey signed the current challenge with the user check done
  async function authenticate(username, purpose, owner, response) {
    const expectedChallenge = await takeChallenge(`${purpose}:${owner}`);
    const stored = response && typeof response.id === "string" ? await passkeys.findOne({ _id: response.id, username }) : null;
    if (!stored) return false;
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: stored._id, publicKey: new Uint8Array(stored.publicKey.buffer || stored.publicKey), counter: stored.counter, transports: stored.transports }
      });
    } catch {
      return false;
    }
    if (!result.verified) return false;
    await passkeys.updateOne({ _id: stored._id }, { $set: { counter: result.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    return true;
  }

  async function list(username) {
    return (await ownedBy(username)).map((p) => ({ id: p._id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
  }

  async function remove(req, id) {
    const { user } = req.auth;
    const result = await passkeys.deleteOne({ _id: id, username: user.username });
    if (!result.deletedCount) throw new AppError(404, "not_found", "Passkey not found.");
    await recordEvent(db, req, { actor: user.username, role: user.role, action: "Passkey removed", details: "A passkey was removed", severity: "warning" });
  }

  return { registrationOptions, register, authenticationOptions, authenticate, list, remove, rpID };
}

module.exports = { createPasskeyService };
