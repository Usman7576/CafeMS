const pino = require("pino");

function createLogger(config) {
  return pino({
    level: config.env === "test" ? "silent" : "info",
    redact: {
      paths: [
        "req.headers.cookie", "req.headers.authorization", 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
        "password", "currentPassword", "newPassword", "code", "token", "secret"
      ],
      censor: "[redacted]"
    }
  });
}

module.exports = { createLogger };
