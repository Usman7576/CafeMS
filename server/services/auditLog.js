// Records security events. The actor comes from the verified session or the attempted
// login, never from a client-supplied field. Phase 4 adds the signed hash chain.
const MAX_TEXT = 200;

function clean(value) {
  // Removes control characters so a value cannot forge extra log lines
  return String(value === undefined || value === null ? "" : value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").slice(0, MAX_TEXT);
}

async function recordEvent(db, req, event, options = {}) {
  await db.collection("audit_events").insertOne({
    at: new Date(),
    actor: clean(event.actor || "system"),
    role: clean(event.role || ""),
    action: clean(event.action),
    details: clean(event.details),
    severity: ["info", "warning", "high"].includes(event.severity) ? event.severity : "info",
    ip: req ? clean(req.ip) : "",
    userAgent: req ? clean(req.get("user-agent")) : "",
    requestId: req ? clean(req.id) : ""
  }, options.session ? { session: options.session } : undefined);
}

module.exports = { recordEvent, clean };
