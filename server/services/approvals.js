// Separation of privilege: sensitive actions wait here until a different person approves them.
const { randomToken } = require("../lib/crypto");
const { AppError, forbidden } = require("../lib/errors");
const { can } = require("../lib/permissions");
const { recordEvent } = require("./auditLog");

const EXPIRY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_PERMISSION = Object.freeze({ refund: "billing.approveRefund", "user-change": "users.manage" });

function createApprovalService({ db }) {
  const approvals = db.collection("approvals");
  const handlers = new Map();

  const register = (type, handler) => handlers.set(type, handler);

  async function create(req, type, payload, summary, session) {
    const actor = req.auth.user;
    const id = randomToken(24);
    await approvals.insertOne({
      _id: id, type, payload, summary, status: "Pending", requestedBy: actor.username,
      createdAt: new Date(), expiresAt: new Date(Date.now() + EXPIRY_MS)
    }, { session });
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Approval requested", details: summary, severity: "warning" }, { session });
    return id;
  }

  const view = (a) => ({ id: a._id, type: a.type, summary: a.summary, status: a.status, requestedBy: a.requestedBy, createdAt: a.createdAt, expiresAt: a.expiresAt });

  async function listFor(role) {
    const types = Object.keys(REQUIRED_PERMISSION).filter((t) => can(role, REQUIRED_PERMISSION[t]));
    const rows = await approvals.find({ type: { $in: types }, status: "Pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(100).toArray();
    return rows.map(view);
  }

  async function loadForDecision(req, id, session) {
    const actor = req.auth.user;
    const approval = await approvals.findOne({ _id: id }, { session });
    if (!approval || !Object.hasOwn(REQUIRED_PERMISSION, approval.type)) throw new AppError(404, "not_found", "Request not found.");
    if (!can(actor.role, REQUIRED_PERMISSION[approval.type])) throw forbidden();
    if (approval.status !== "Pending" || approval.expiresAt.getTime() <= Date.now()) throw new AppError(409, "already_decided", "This request has already been decided or has expired.");
    if (approval.requestedBy === actor.username) throw new AppError(403, "same_person", "A different person must approve your own request.");
    if (approval.payload.target === actor.username) throw new AppError(403, "same_person", "You cannot decide a request about your own account.");
    // Whoever created or last reset the requester's account could be both people at once
    if (approval.type === "refund") {
      const requester = await db.collection("users").findOne({ username: approval.requestedBy }, { session });
      if (requester && requester.sponsor === actor.username) throw new AppError(403, "same_person", "You set up this person's account, so a different person must approve.");
    }
    return approval;
  }

  async function settle(id, status, username, session) {
    const result = await approvals.updateOne({ _id: id, status: "Pending" }, { $set: { status, decidedBy: username, decidedAt: new Date() } }, { session });
    if (result.modifiedCount !== 1) throw new AppError(409, "already_decided", "This request has already been decided or has expired.");
  }

  async function approve(req, id, session) {
    const actor = req.auth.user;
    const approval = await loadForDecision(req, id, session);
    await settle(id, "Approved", actor.username, session);
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Approval granted", details: `${approval.summary}, requested by ${approval.requestedBy}`, severity: "high" }, { session });
    return handlers.get(approval.type).approve(req, approval, session);
  }

  async function reject(req, id, session) {
    const actor = req.auth.user;
    const approval = await loadForDecision(req, id, session);
    await settle(id, "Rejected", actor.username, session);
    await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Approval rejected", details: `${approval.summary}, requested by ${approval.requestedBy}`, severity: "warning" }, { session });
    const handler = handlers.get(approval.type);
    if (handler.reject) await handler.reject(req, approval, session);
  }

  return { register, create, listFor, approve, reject };
}

module.exports = { createApprovalService };
