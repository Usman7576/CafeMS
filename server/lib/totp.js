// Authenticator codes (TOTP, RFC 6238) through one small interface, so the library behind it can change.
const { generateSecret, generateSync, generateURI, verifySync } = require("otplib");

const SECRET_BYTES = 20;
// One 30-second step either side allows for a phone clock that is slightly out
const TOLERANCE_SECONDS = 30;

module.exports = {
  generateSecret: () => generateSecret({ length: SECRET_BYTES }),
  generate: (secret) => generateSync({ secret }),
  keyuri: (username, issuer, secret) => generateURI({ issuer, label: username, secret }),
  // The step offset of a valid code, or null. Malformed input is simply not valid.
  checkDelta(token, secret) {
    try {
      const result = verifySync({ secret, token, epochTolerance: TOLERANCE_SECONDS });
      return result.valid ? result.delta : null;
    } catch {
      return null;
    }
  }
};
