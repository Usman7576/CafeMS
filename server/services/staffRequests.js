// Staff requests (quiz Q2 and Q3). Role 1 (Waiter, Kitchen, Cashier) submits requests and sees only their
// own. Role 2 (Manager) reviews them: claims a Pending request, then resolves or rejects it.
//
//   Pending --claim (any Manager)--> In Review --resolve (assigned reviewer)--> Resolved
//                                              \-reject + reason (assigned)--> Rejected
//
// Every write runs in a MongoDB transaction together with its history entry and audit-log entry, so a
// change and its record are saved together or not at all. Each change must name the version it was based
// on; a change made from an old version is refused instead of overwriting newer data.
const { AppError } = require("../lib/errors");
const { encrypt } = require("../lib/crypto");
const { maskPhone } = require("../lib/domain");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

const PAGE_SIZE = 5;
const SUBMITTERS = ["Waiter", "Barista", "Kitchen", "Cashier"];
const REVIEWERS = ["Manager"];
const TERMINAL = ["Resolved", "Rejected"];
const TRANSITIONS = Object.freeze({
  claim: { from: "Pending", to: "In Review", label: "Claimed" },
  resolve: { from: "In Review", to: "Resolved", label: "Resolved" },
  reject: { from: "In Review", to: "Rejected", label: "Rejected" }
});

// Duplicates are compared after trimming, collapsing spaces and ignoring case
const titleKey = (title) => title.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
// Search text is matched literally: regular-expression characters typed by a user have no special meaning
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const notFound = () => new AppError(404, "not_found", "Request not found.");

function createStaffRequestService({ config, db }) {
  const requests = db.collection("staff_requests");
  const history = db.collection("request_history");
  const contactContext = (id) => `staff-request-contact:${id}`;

  // The contact number is sensitive: it is stored encrypted and only ever returned masked
  const view = (r) => ({
    id: r._id, title: r.title, description: r.description, category: r.category, status: r.status, version: r.version,
    owner: r.owner, reviewer: r.reviewer || null, reason: r.reason || null, contact: r.contactMask || "",
    createdAt: r.createdAt, updatedAt: r.updatedAt
  });

  // Which records a person may see at all. Applied before any filter, count or page is worked out.
  function scope(user) {
    if (SUBMITTERS.includes(user.role)) return { owner: user.username };
    if (REVIEWERS.includes(user.role)) return { $or: [{ status: "Pending" }, { reviewer: user.username }] };
    throw new AppError(403, "forbidden", "You do not have permission to do that.");
  }
  function canSee(user, r) {
    if (SUBMITTERS.includes(user.role)) return r.owner === user.username;
    if (REVIEWERS.includes(user.role)) return r.status === "Pending" || r.reviewer === user.username;
    return false;
  }

  // ---------- Q2: atomic creation ----------
  async function create(req, input) {
    const actor = req.auth.user;
    // The number is taken outside the transaction, so two people creating at once do not conflict on it
    const seq = await nextSequence(db, "staff_request", 1000);
    const id = `SR-${seq}`;
    const now = new Date();
    const doc = {
      _id: id, seq, owner: actor.username, title: input.title, titleKey: titleKey(input.title), description: input.description,
      category: input.category, status: "Pending", version: 1, reviewer: null, reason: null,
      contactEnc: input.contactPhone ? encrypt(input.contactPhone, contactContext(id), config.data) : null,
      contactMask: input.contactPhone ? maskPhone(input.contactPhone) : "",
      createdAt: now, updatedAt: now
    };
    try {
      await inTransaction(db, async (session) => {
        await requests.insertOne(doc, { session });
        await history.insertOne({ requestId: id, version: 1, action: "Created", from: null, to: "Pending", actor: actor.username, role: actor.role, at: now }, { session });
        await recordEvent(db, req, { actor: actor.username, role: actor.role, action: "Staff request created", details: `${id} · ${input.category}` }, { session });
      });
    } catch (error) {
      if (error.code === 11000 && /one_title_per_owner|titleKey/.test(String(error.message))) {
        throw new AppError(409, "duplicate_title", "You already have a request with this title.");
      }
      throw error;
    }
    // The response is the record as the database committed it, not the object built above
    return view(await requests.findOne({ _id: id }));
  }

  // ---------- Q3 A: one listing endpoint with search, filters, sorting and pages ----------
  async function list(user, query) {
    const parts = [scope(user)];
    if (query.category) parts.push({ category: query.category });
    if (query.status) parts.push({ status: query.status });
    if (query.search) parts.push({ titleKey: { $regex: escapeRegex(titleKey(query.search)) } });
    const filter = { $and: parts };
    const dir = query.sort === "oldest" ? 1 : -1;
    const [total, rows] = await Promise.all([
      requests.countDocuments(filter),
      // seq breaks ties between records created in the same millisecond, so pages never overlap or skip
      requests.find(filter).sort({ createdAt: dir, seq: dir }).skip((query.page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray()
    ]);
    return { items: rows.map(view), total, page: query.page, pageSize: PAGE_SIZE, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  }

  // A record outside someone's scope is reported as not found, so its existence is not disclosed
  async function get(user, id) {
    const r = await requests.findOne({ _id: id });
    if (!r || !canSee(user, r)) throw notFound();
    return view(r);
  }

  // ---------- Q3 B and C: state machine with versions, and atomic history ----------
  async function transition(req, id, action, input) {
    const rule = TRANSITIONS[action];
    const actor = req.auth.user;
    if (!rule || !REVIEWERS.includes(actor.role)) throw new AppError(403, "forbidden", "You do not have permission to do that.");
    await inTransaction(db, async (session) => {
      // Order matters: a reviewer who lost a race must hear "conflict", not "not found", and finalizing a
      // request nobody has claimed is a state error, not a permission error.
      const current = await requests.findOne({ _id: id }, { session });
      if (!current) throw notFound();
      if (TERMINAL.includes(current.status)) throw new AppError(409, "terminal", `This request is already ${current.status.toLowerCase()} and cannot be changed.`);
      if (current.version !== input.version) throw new AppError(409, "stale_version", "This request was changed by someone else. Reload it and try again.");
      if (current.status !== rule.from) throw new AppError(409, "wrong_status", `Only ${rule.from === "In Review" ? "an" : "a"} ${rule.from} request can be ${rule.label.toLowerCase()}.`);
      if (action !== "claim" && current.reviewer !== actor.username) throw new AppError(403, "not_assigned", "Only the manager who claimed this request can finalize it.");

      const now = new Date();
      const set = { status: rule.to, version: input.version + 1, updatedAt: now };
      if (action === "claim") set.reviewer = actor.username;
      if (action === "reject") set.reason = input.reason;
      // The version in the filter makes this a compare-and-set: it changes nothing if another change won
      const result = await requests.updateOne({ _id: id, version: input.version, status: rule.from }, { $set: set }, { session });
      if (result.modifiedCount !== 1) throw new AppError(409, "stale_version", "This request was changed by someone else. Reload it and try again.");
      await history.insertOne({
        requestId: id, version: input.version + 1, action: rule.label, from: rule.from, to: rule.to, actor: actor.username, role: actor.role, at: now,
        ...(action === "reject" ? { reason: input.reason } : {})
      }, { session });
      await recordEvent(db, req, { actor: actor.username, role: actor.role, action: `Staff request ${rule.label.toLowerCase()}`, details: `${id} · ${rule.from} to ${rule.to}` }, { session });
    });
    return view(await requests.findOne({ _id: id }));
  }

  // History is shown only to people who may see the record itself: its owner or an authorized reviewer
  async function historyOf(user, id) {
    await get(user, id);
    const rows = await history.find({ requestId: id }).sort({ version: 1 }).toArray();
    return rows.map((h) => ({ version: h.version, action: h.action, from: h.from, to: h.to, actor: h.actor, role: h.role, at: h.at, reason: h.reason || null }));
  }

  return { create, list, get, transition, history: historyOf, PAGE_SIZE };
}

module.exports = { createStaffRequestService, titleKey, PAGE_SIZE };
