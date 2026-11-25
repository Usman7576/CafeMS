// Live updates with Server-Sent Events. A change only says WHICH area changed ("orders", "bills"),
// never the data itself: each screen then re-reads its own role-filtered snapshot, so the stream
// cannot leak anything a role is not allowed to see.
const { EventEmitter } = require("events");

// The first part of an API path names the area it changes
const TOPIC_OF = Object.freeze({
  orders: "orders", kitchen: "orders", tables: "orders",
  billing: "bills", bills: "bills", payments: "bills", customers: "bills", shifts: "bills",
  inventory: "inventory", menu: "menu", reservations: "reservations",
  users: "users", register: "users", setup: "users", settings: "settings",
  alerts: "alerts", approvals: "approvals", requests: "requests"
});

// Which areas each role's screens show
const TOPICS_FOR = Object.freeze({
  Waiter: ["orders", "menu", "reservations", "settings", "requests"],
  Kitchen: ["orders", "menu", "settings", "requests"],
  Barista: ["orders", "menu", "settings", "requests"],
  Cashier: ["orders", "bills", "menu", "settings", "requests"],
  Manager: ["orders", "bills", "inventory", "menu", "reservations", "approvals", "settings", "requests"],
  Admin: ["orders", "bills", "inventory", "menu", "reservations", "users", "settings", "alerts", "approvals"]
});

const HEARTBEAT_MS = 25 * 1000;
const RECHECK_MS = 60 * 1000;
const MAX_STREAMS_PER_USER = 6;

function createEventBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const open = new Map();

  function publish(topic) {
    if (topic) bus.emit("change", topic);
  }

  // Announces each successful change once its response has gone out
  function announce(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const first = req.path.split("/")[1] || "";
      publish(Object.hasOwn(TOPIC_OF, first) ? TOPIC_OF[first] : null);
    });
    return next();
  }

  // One open stream. `stillValid` re-checks the session now and then, so a revoked or expired
  // session, or a changed role, ends the stream.
  function stream(req, res, stillValid) {
    const { username, role } = req.auth.user;
    const count = open.get(username) || 0;
    if (count >= MAX_STREAMS_PER_USER) {
      res.status(429).json({ error: { code: "too_many_streams", message: "Too many open screens. Close a tab and try again." } });
      return;
    }
    open.set(username, count + 1);
    const wanted = new Set(TOPICS_FOR[role] || []);
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write("retry: 5000\n\n");

    // Changes arriving together are sent as one message
    let pending = new Set();
    let flushTimer = null;
    const onChange = (topic) => {
      if (!wanted.has(topic)) return;
      pending.add(topic);
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          res.write(`event: change\ndata: ${JSON.stringify({ topics: [...pending] })}\n\n`);
          pending = new Set();
          flushTimer = null;
        }, 150);
      }
    };
    bus.on("change", onChange);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const recheck = setInterval(async () => {
      try {
        if (!(await stillValid())) {
          res.write("event: ended\ndata: {}\n\n");
          res.end();
        }
      } catch (_error) {
        res.end();
      }
    }, RECHECK_MS);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      bus.off("change", onChange);
      clearInterval(heartbeat);
      clearInterval(recheck);
      clearTimeout(flushTimer);
      const left = (open.get(username) || 1) - 1;
      if (left > 0) open.set(username, left); else open.delete(username);
    };
    req.on("close", close);
    res.on("close", close);
  }

  return { publish, announce, stream, openCount: () => [...open.values()].reduce((a, b) => a + b, 0) };
}

module.exports = { createEventBus, TOPIC_OF, TOPICS_FOR };
