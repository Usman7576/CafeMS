// TOTP authenticator codes. Secrets are encrypted at rest, a code works only once,
// and recovery codes are stored as hashes and removed on use.
const crypto = require("crypto");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const { encrypt, decrypt, hashToken } = require("../lib/crypto");

const totp = authenticator.clone({ window: 1, step: 30, digits: 6 });
const ISSUER = "CafeMS";
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function secretContext(username) {
  return `mfa-secret:${username}`;
}

function createMfaService(config, db) {
  const users = db.collection("users");

  async function beginEnrolment(username) {
    const secret = totp.generateSecret(20);
    const otpauthUri = totp.keyuri(username, ISSUER, secret);
    return {
      secretEnc: encrypt(secret, secretContext(username), config.data),
      manualKey: secret,
      qrDataUrl: await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 1, width: 220 })
    };
  }

  function checkDelta(code, secretEnc, username) {
    const secret = decrypt(secretEnc, secretContext(username), config.data);
    return totp.checkDelta(code, secret);
  }

  // The atomic filter means a code already used (same or earlier time step) is rejected, even in a race
  async function verifyCode(user, code) {
    if (!user.mfa || !user.mfa.enabled) return false;
    const delta = checkDelta(code, user.mfa.secretEnc, user.username);
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    const result = await users.updateOne(
      { username: user.username, "mfa.lastStep": { $lt: step } },
      { $set: { "mfa.lastStep": step } }
    );
    return result.modifiedCount === 1;
  }

  async function verifyRecoveryCode(user, code) {
    const hash = hashToken(String(code).toUpperCase());
    const result = await users.updateOne(
      { username: user.username, "mfa.enabled": true, "mfa.recoveryHashes": hash },
      { $pull: { "mfa.recoveryHashes": hash } }
    );
    return result.modifiedCount === 1;
  }

  function generateRecoveryCodes() {
    return Array.from({ length: config.auth.recoveryCodes }, () => {
      let code = "";
      for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
      return `${code.slice(0, 5)}-${code.slice(5)}`;
    });
  }

  // Confirms the first code against the pending secret, then switches MFA on
  async function completeEnrolment(username, secretEnc, code) {
    const delta = checkDelta(code, secretEnc, username);
    if (delta === null) return null;
    const codes = generateRecoveryCodes();
    await users.updateOne({ username }, {
      $set: {
        mfa: {
          enabled: true,
          secretEnc,
          lastStep: Math.floor(Date.now() / 30000) + delta,
          recoveryHashes: codes.map(hashToken),
          enrolledAt: new Date()
        }
      }
    });
    return codes;
  }

  return { beginEnrolment, verifyCode, verifyRecoveryCode, completeEnrolment };
}

module.exports = { createMfaService };
