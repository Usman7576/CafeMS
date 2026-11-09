// The public cafe website's API. These routes need no sign-in, so each returns only what a customer may
// see: no recipes, stock levels or staff data. Bookings are rate limited and wait for staff to confirm.
const express = require("express");
const path = require("path");
const schemas = require("../lib/schemas");
const { publicRoute, validate } = require("../middleware/auth");
const { limiter } = require("../middleware/security");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createPublicRouter({ config, services }) {
  const router = express.Router();
  const { catalog, cafe, photos, reservations, publicCache } = services;
  const bookingLimiter = limiter(60 * 60 * 1000, config.limits.publicBookingsPerHour, "Too many booking requests. Please try again later or call us.");
  // A visitor reads the menu and details once per visit, so this is far below the general API limit
  const readLimiter = limiter(60 * 1000, config.limits.publicReadsPerMinute, "Too many requests. Please wait a moment.");
  router.use(readLimiter);
  const ACCEPTED = { ok: true, message: "Thank you. We've received your request and will confirm your table soon." };

  router.get("/info", publicRoute, wrap(async (_req, res) => res.json(await publicCache.get("info", () => cafe.get()))));

  router.get("/menu", publicRoute, wrap(async (_req, res) => {
    res.json(await publicCache.get("menu", async () => ({
      items: (await catalog.listForSale()).map((m) => ({ id: m.id, name: m.name, cat: m.cat, price: m.price, desc: m.desc, hasPhoto: m.hasPhoto, available: m.available }))
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

  return router;
}

module.exports = { createPublicRouter };
