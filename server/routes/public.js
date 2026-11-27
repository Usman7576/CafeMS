// The public cafe website's API. These routes need no sign-in, so each returns only what a customer may
// see: no recipes, stock levels or staff data. Bookings are rate limited and wait for staff to confirm.
const express = require("express");
const path = require("path");
const schemas = require("../lib/schemas");
const { publicRoute, validate } = require("../middleware/auth");
const { limiter } = require("../middleware/security");
const { inTransaction } = require("../lib/tx");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createPublicRouter({ config, db, services }) {
  const router = express.Router();
  const { catalog, cafe, photos, reservations, publicCache, userService, guests, orderService, events, settings } = services;
  const REGISTERED = { ok: true, message: "Thank you. An Admin will review your request. You can sign in once it is approved." };
  const bookingLimiter = limiter(60 * 60 * 1000, config.limits.publicBookingsPerHour, "Too many booking requests. Please try again later or call us.");
  // A visitor reads the menu and details once per visit, so this is far below the general API limit
  const readLimiter = limiter(60 * 1000, config.limits.publicReadsPerMinute, "Too many requests. Please wait a moment.");
  router.use(readLimiter);
  const ACCEPTED = { ok: true, message: "Thank you. We've received your request and will confirm your table soon." };

  router.get("/info", publicRoute, wrap(async (_req, res) => res.json(await publicCache.get("info", () => cafe.get()))));

  router.get("/menu", publicRoute, wrap(async (_req, res) => {
    res.json(await publicCache.get("menu", async () => ({
      items: (await catalog.listForSale()).map((m) => ({ id: m.id, name: m.name, cat: m.cat, price: m.price, desc: m.desc, options: m.options, hasPhoto: m.hasPhoto, available: m.available }))
    })));
  }));

  router.get("/menu/:id/photo", publicRoute, validate(schemas.params.numericId, "params"), wrap(async (req, res) => {
    const photo = await photos.read(Number(req.validParams.id));
    res.set({ "Content-Type": photo.type, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" });
    res.sendFile(path.resolve(photo.path), { dotfiles: "deny" });
  }));

  // The answer is the same whether or not a booking was stored, so it cannot be used to discover who has
  // booked. A filled-in hidden field marks a bot: it gets the same answer and nothing is saved.
  router.post("/reservations", publicRoute, bookingLimiter, validate(schemas.publicReservation), wrap(async (req, res) => {
    const { website, ...booking } = req.body;
    if (!website) await reservations.createOnline(req, booking);
    res.status(202).json(ACCEPTED);
  }));

  // Free booking times for a day and party size, so the website only offers times that can be booked
  router.get("/availability", publicRoute, validate(schemas.availabilityQuery, "query"), wrap(async (req, res) => {
    res.json({ times: await reservations.availability(req.validQuery.date, req.validQuery.party) });
  }));

  // A rating from a guest. A filled-in hidden field marks a bot: it gets the same answer and nothing is saved.
  const feedbackLimiter = limiter(60 * 60 * 1000, config.limits.publicBookingsPerHour, "Thank you. You have already sent us feedback recently.");
  router.post("/feedback", publicRoute, feedbackLimiter, validate(schemas.feedback), wrap(async (req, res) => {
    const { website, ...rating } = req.body;
    if (!website) await guests.addFeedback(req, rating);
    res.status(202).json({ ok: true, message: "Thank you for telling us how we did." });
  }));

  // ---------- Ordering from the website or a table ----------
  // What a guest may order and how: the order types open now, and the tax rate for the total shown
  router.get("/ordering", publicRoute, (_req, res) => {
    const s = settings.get();
    res.json({ open: s.online.ordering, qr: s.online.qr, takeaway: s.orderTypes.takeaway, delivery: s.orderTypes.delivery, taxRate: settings.taxRate() });
  });
  router.get("/table/:code", publicRoute, validate(schemas.tableCode, "params"), wrap(async (req, res) => res.json(await orderService.tableFromCode(req.validParams.code))));
  // Each address may send only a few orders an hour; staff accept each one before it is made.
  // A filled-in hidden field marks a bot: it gets an answer with no tracking link and nothing is saved.
  const orderLimiter = limiter(60 * 60 * 1000, config.limits.publicBookingsPerHour, "Too many orders from this connection. Please call us.");
  router.post("/orders", publicRoute, orderLimiter, validate(schemas.guestOrder), wrap(async (req, res) => {
    const { website, ...order } = req.body;
    if (website) return res.status(202).json({ ok: true });
    const placed = await inTransaction(db, (session) => orderService.placeFromGuest(req, order, session));
    events.publish("orders");
    return res.status(201).json({ ok: true, id: placed.id, label: placed.label, total: placed.totals.total, track: `/track.html?t=${placed.token}` });
  }));
  router.get("/orders/:token", publicRoute, validate(schemas.trackToken, "params"), wrap(async (req, res) => res.json(await orderService.track(req.validParams.token))));

  // Staff self-registration. The account waits as Pending until an Admin approves it and sets the role.
  // A filled-in hidden field marks a bot: it gets the same answer and nothing is saved.
  const registerLimiter = limiter(60 * 60 * 1000, config.limits.publicRegistrationsPerHour, "Too many registration requests. Please try again later.");
  router.post("/register", publicRoute, registerLimiter, validate(schemas.registration), wrap(async (req, res) => {
    const { website, ...details } = req.body;
    if (!website) await userService.register(req, details);
    res.status(202).json(REGISTERED);
  }));

  return router;
}

module.exports = { createPublicRouter };
