const pino = require("pino");

function createLogger(config, destination) {
  return pino({
    level: config.env === "test" ? "silent" : "info",
    redact: {
      paths: [
        "req.headers.cookie", "req.headers.authorization", 'req.headers["x-csrf-token"]', 'req.headers["x-gateway-signature"]', 'req.headers["idempotency-key"]', 'res.headers["set-cookie"]',
        "password", "currentPassword", "newPassword", "code", "token", "secret"
      ],
      censor: "[redacted]"
    }
  }, destination);
}

module.exports = { createLogger };
