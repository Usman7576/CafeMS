// Payment gateway boundary (soft sync). This project uses a simulated gateway, as a real one needs a
// merchant account. No card or wallet details enter this system at any point.
const crypto = require("crypto");
const { safeEqual } = require("../lib/crypto");

const CALLBACK_WINDOW_MS = 5 * 60 * 1000;

function createSimulatedGateway(delayMs = 200) {
  return {
    charge: ({ reference, amount }) => new Promise((resolve) => {
      setTimeout(() => resolve({ status: "approved", reference, amount, gatewayRef: `SIM-${crypto.randomBytes(6).toString("hex")}` }), delayMs);
    }),
    refund: ({ reference, amount }) => new Promise((resolve) => {
      setTimeout(() => resolve({ status: "refunded", reference, amount, gatewayRef: `SIM-R-${crypto.randomBytes(6).toString("hex")}` }), delayMs);
    })
  };
}

// Rejects if the gateway does not answer in time, so a slow provider cannot hang the till
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The payment gateway did not answer in time.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function callbackSignature(secret, timestamp, body) {
  const message = [timestamp, body.reference, body.amount, body.status, body.gatewayRef].join(".");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Proves a callback came from the gateway and is recent, which stops forgery and replay
function verifyCallback(secret, timestamp, signature, body, now = Date.now()) {
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > CALLBACK_WINDOW_MS) return false;
  return safeEqual(signature || "", callbackSignature(secret, timestamp, body));
}

module.exports = { createSimulatedGateway, withTimeout, callbackSignature, verifyCallback };
