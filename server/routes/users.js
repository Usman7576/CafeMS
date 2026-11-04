const express = require("express");
const { z } = require("zod");
const schemas = require("../lib/schemas");
const { inTransaction } = require("../lib/tx");
const { validate } = require("../middleware/auth");

const USERNAME = /^[a-z][a-z0-9._]{2,29}$/;
const usernameParams = z.object({ username: z.string().regex(USERNAME) }).strict();
const invitationSchema = z.object({
  username: z.string().trim().toLowerCase().regex(USERNAME, "!Username must be 3-30 letters, numbers, dots or underscores, starting with a letter."),
  name: z.string().trim().min(2, "!Enter the full name (2-60 characters).").max(60, "!Enter the full name (2-60 characters)."),
  role: schemas.userRole.shape.role
}).strict();

function createUsersRouter({ db, middleware, services }) {
  const router = express.Router();
  const { requireAuth, requirePermission, requireStepUp } = middleware;
  const { userService } = services;
  const view = [requireAuth, requirePermission("users.manage")];
  const change = [...view, requireStepUp];

  const submit = (req, res, next, details, summary) => inTransaction(db, (session) => userService.request(req, details, summary, session))
    .then((outcome) => res.status(outcome.status).json(outcome.body))
    .catch(next);

  router.get("/", ...view, (_req, res, next) => userService.list().then((users) => res.json({ users })).catch(next));

  router.post("/invitations", ...change, validate(invitationSchema), (req, res, next) => {
    const { username, name, role } = req.body;
    submit(req, res, next, { action: "invite", target: username, name, role }, `Invite ${username} as ${role}`);
  });

  const onOtherUser = (handler) => (req, res, next) => userService.assertNotSelf(req, req.validParams.username).then(() => handler(req, res, next)).catch(next);

  router.post("/:username/reset-link", ...change, validate(usernameParams, "params"), onOtherUser((req, res, next) => {
    submit(req, res, next, { action: "reset", target: req.validParams.username }, `Reset account ${req.validParams.username}`);
  }));
  router.post("/:username/role", ...change, validate(usernameParams, "params"), validate(schemas.userRole), onOtherUser((req, res, next) => {
    submit(req, res, next, { action: "role", target: req.validParams.username, role: req.body.role }, `Change ${req.validParams.username} to ${req.body.role}`);
  }));
  router.post("/:username/status", ...change, validate(usernameParams, "params"), validate(schemas.userStatus), onOtherUser((req, res, next) => {
    submit(req, res, next, { action: "status", target: req.validParams.username, status: req.body.status }, `Set ${req.validParams.username} to ${req.body.status}`);
  }));
  router.post("/:username/unlock", ...change, validate(usernameParams, "params"), (req, res, next) => {
    userService.unlock(req, req.validParams.username).then(() => res.status(204).end()).catch(next);
  });

  return router;
}

module.exports = { createUsersRouter };
