// Guests: loyalty members and their points, vouchers, the walk-in waitlist and feedback.
//
// A member is found by their mobile number through a keyed index, so the number itself is never
// stored in readable form or searched as text. Points are earned on paid bills and can be spent as a
// payment method; every change is written to a ledger, so a member's balance can always be explained.
const { AppError } = require("../lib/errors");
const { maskPhone, localDate } = require("../lib/domain");
const { encrypt, decrypt, blindIndex } = require("../lib/crypto");
const { nextSequence, inTransaction } = require("../lib/tx");
const { recordEvent } = require("./auditLog");

function createGuestService({ config, db, settings }) {
  const customers = db.collection("customers");
  const ledger = db.collection("loyalty_ledger");
  const vouchers = db.collection("vouchers");
  const waitlist = db.collection("waitlist");
  const feedback = db.collection("feedback");

  const audit = (req, action, details, session, severity = "info") => recordEvent(db, req, { actor: req.auth ? req.auth.user.username : "online", role: req.auth ? req.auth.user.role : "", action, details, severity }, { session });
  const ctx = (field, id) => `customer-${field}:${id}`;

  // ---------- Members ----------
  const memberView = (c) => ({
    id: c._id, name: c.nameEnc ? decrypt(c.nameEnc, ctx("name", c._id), config.data) : "Erased member", phone: c.phoneMask || "",
    points: c.points, worth: Math.floor(c.points * settings.get().loyalty.pointValue), visits: c.visits, spent: c.spent,
    joinedAt: c.createdAt, lastVisitAt: c.lastVisitAt || null
  });

  async function enrol(req, input) {
    const phoneIndex = blindIndex(input.phone, config.blindIndexKey);
    return inTransaction(db, async (session) => {
      if (await customers.findOne({ phoneIndex }, { session })) throw new AppError(409, "member_exists", "This number is already a member. Look it up instead.");
      const id = `CU-${await nextSequence(db, "customer", 1000, session)}`;
      const doc = {
        _id: id, nameEnc: encrypt(input.name, ctx("name", id), config.data), phoneEnc: encrypt(input.phone, ctx("phone", id), config.data),
        phoneIndex, phoneMask: maskPhone(input.phone), points: 0, visits: 0, spent: 0, createdAt: new Date(), joinedBy: req.auth.user.username
      };
      try {
        await customers.insertOne(doc, { session });
      } catch (error) {
        if (error.code === 11000) throw new AppError(409, "member_exists", "This number is already a member. Look it up instead.");
        throw error;
      }
      await audit(req, "Loyalty member added", `${id} · ${doc.phoneMask}`, session);
      return memberView(doc);
    });
  }

  // Found only by the exact number; nothing is returned for a number that is not a member
  async function lookup(phone) {
    const c = await customers.findOne({ phoneIndex: blindIndex(phone, config.blindIndexKey) });
    if (!c) throw new AppError(404, "not_found", "No member has that number.");
    return memberView(c);
  }

  async function list() {
    return (await customers.find({ nameEnc: { $exists: true } }).sort({ spent: -1 }).limit(300).toArray()).map(memberView);
  }

  async function history(id) {
    const rows = await ledger.find({ customerId: id }).sort({ at: -1 }).limit(100).toArray();
    return rows.map((r) => ({ type: r.type, points: r.points, billNo: r.billNo || null, at: r.at, note: r.note || "" }));
  }

  // Points for a paid bill: whole points per Rs 100. Called inside the payment's own transaction.
  async function earn(bill, session) {
    const loyalty = settings.get().loyalty;
    if (!bill.customerId || bill.method === "Points" || !loyalty.enabled || bill.pointsEarned) return 0;
    const points = Math.floor(bill.total / 100) * loyalty.earnPer100;
    const updated = await customers.findOneAndUpdate(
      { _id: bill.customerId, nameEnc: { $exists: true } },
      { $inc: { points, visits: bill.part > 1 ? 0 : 1, spent: bill.total }, $set: { lastVisitAt: new Date() } },
      { session }
    );
    if (!updated) return 0;
    await db.collection("bills").updateOne({ _id: bill._id }, { $set: { pointsEarned: points } }, { session });
    if (points) await ledger.insertOne({ customerId: bill.customerId, type: "earn", points, billNo: bill._id, at: new Date() }, { session });
    return points;
  }

  // Paying with points: the points are taken at once, and only if the member has enough
  async function spend(customerId, amount, billNo, session) {
    const loyalty = settings.get().loyalty;
    if (!loyalty.enabled) throw new AppError(400, "invalid_input", "Loyalty points are switched off.");
    const points = Math.ceil(amount / loyalty.pointValue);
    const updated = await customers.findOneAndUpdate({ _id: customerId, nameEnc: { $exists: true }, points: { $gte: points } }, { $inc: { points: -points }, $set: { lastVisitAt: new Date() } }, { returnDocument: "after", session });
    if (!updated) {
      const c = await customers.findOne({ _id: customerId }, { session });
      throw c ? new AppError(409, "not_enough_points", `The member has ${c.points} points, worth Rs ${Math.floor(c.points * loyalty.pointValue)}.`) : new AppError(404, "not_found", "Member not found.");
    }
    await ledger.insertOne({ customerId, type: "redeem", points: -points, billNo, at: new Date() }, { session });
    return points;
  }

  // A refund takes back the points the bill earned, or returns the points it was paid with
  async function reverse(bill, session) {
    if (!bill.customerId) return;
    if (bill.method === "Points") {
      const back = Math.ceil(bill.total / settings.get().loyalty.pointValue);
      await customers.updateOne({ _id: bill.customerId }, { $inc: { points: back } }, { session });
      await ledger.insertOne({ customerId: bill.customerId, type: "refund", points: back, billNo: bill._id, at: new Date() }, { session });
    } else if (bill.pointsEarned) {
      const c = await customers.findOne({ _id: bill.customerId }, { session });
      const take = Math.min(bill.pointsEarned, c ? c.points : 0);
      await customers.updateOne({ _id: bill.customerId }, { $inc: { points: -take, spent: -bill.total } }, { session });
      await ledger.insertOne({ customerId: bill.customerId, type: "refund", points: -take, billNo: bill._id, at: new Date() }, { session });
    }
  }

  // ---------- Vouchers ----------
  const voucherView = (v) => ({ code: v._id, kind: v.kind, value: v.value, minSpend: v.minSpend || 0, expiresOn: v.expiresOn || "", maxUses: v.maxUses || null, uses: v.uses, active: v.active, createdBy: v.createdBy, createdAt: v.createdAt });
  const listVouchers = async () => (await vouchers.find().sort({ createdAt: -1 }).limit(200).toArray()).map(voucherView);

  async function createVoucher(req, input) {
    return inTransaction(db, async (session) => {
      const doc = { _id: input.code, kind: input.kind, value: input.value, minSpend: input.minSpend, expiresOn: input.expiresOn || null, maxUses: input.maxUses || null, uses: 0, active: input.active, createdBy: req.auth.user.username, createdAt: new Date() };
      try {
        await vouchers.insertOne(doc, { session });
      } catch (error) {
        if (error.code === 11000) throw new AppError(409, "code_taken", "That code already exists.");
        throw error;
      }
      await audit(req, "Voucher created", `${doc._id} · ${doc.kind === "percent" ? `${doc.value}%` : `Rs ${doc.value}`} off`, session, "warning");
      return voucherView(doc);
    });
  }

  async function setVoucherActive(req, code, active) {
    return inTransaction(db, async (session) => {
      const updated = await vouchers.findOneAndUpdate({ _id: code }, { $set: { active } }, { returnDocument: "after", session });
      if (!updated) throw new AppError(404, "not_found", "Voucher not found.");
      await audit(req, active ? "Voucher switched on" : "Voucher switched off", code, session);
      return voucherView(updated);
    });
  }

  // Takes one use of a voucher for a bill of this subtotal, or explains why it cannot be used.
  // The use is counted in the same transaction as the payment, so a code with one use left cannot be
  // used twice at once.
  async function redeemVoucher(code, subtotal, session) {
    const v = await vouchers.findOne({ _id: code }, { session });
    const invalid = new AppError(400, "invalid_voucher", "That voucher code is not valid.");
    if (!v || !v.active) throw invalid;
    if (v.expiresOn && v.expiresOn < localDate()) throw new AppError(400, "invalid_voucher", "That voucher has expired.");
    if (subtotal < (v.minSpend || 0)) throw new AppError(400, "invalid_voucher", `That voucher needs a spend of at least Rs ${v.minSpend.toLocaleString()}.`);
    const taken = await vouchers.findOneAndUpdate(
      { _id: code, active: true, ...(v.maxUses ? { uses: { $lt: v.maxUses } } : {}) },
      { $inc: { uses: 1 } }, { returnDocument: "after", session }
    );
    if (!taken) throw new AppError(400, "invalid_voucher", "That voucher has been used up.");
    return v.kind === "percent" ? { discountPct: v.value, fixed: 0 } : { discountPct: 0, fixed: v.value };
  }

  // ---------- Waitlist ----------
  const waitView = (w) => ({
    id: w._id, name: w.name, party: w.party, phone: w.phoneMask || "", quotedMinutes: w.quotedMinutes, status: w.status,
    table: w.table || null, createdAt: w.createdAt, seatedAt: w.seatedAt || null, waited: Math.round(((w.seatedAt || new Date()) - w.createdAt) / 60000)
  });
  async function listWaitlist() {
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
    return (await waitlist.find({ createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(200).toArray()).map(waitView);
  }
  async function addWaiting(req, input) {
    return inTransaction(db, async (session) => {
      const id = `WL-${await nextSequence(db, "waitlist", 100, session)}`;
      const doc = { _id: id, name: input.name, party: input.party, quotedMinutes: input.quotedMinutes, status: "Waiting", createdAt: new Date(), addedBy: req.auth.user.username };
      if (input.phone) { doc.phoneEnc = encrypt(input.phone, `waitlist-phone:${id}`, config.data); doc.phoneMask = maskPhone(input.phone); }
      await waitlist.insertOne(doc, { session });
      await audit(req, "Added to waitlist", `${id} · party of ${input.party}`, session);
      return waitView(doc);
    });
  }
  async function closeWaiting(req, id, status, table) {
    return inTransaction(db, async (session) => {
      if (table !== undefined && !settings.hasTable(table)) throw new AppError(400, "invalid_input", "Choose a valid table.");
      const updated = await waitlist.findOneAndUpdate(
        { _id: id, status: "Waiting" },
        { $set: { status, seatedAt: new Date(), ...(table ? { table } : {}) }, $unset: { phoneEnc: "" } },
        { returnDocument: "after", session }
      );
      if (!updated) throw new AppError(409, "bad_status", "This guest is no longer waiting.");
      await audit(req, status === "Seated" ? "Waitlist guest seated" : "Waitlist guest left", `${id}${table ? ` · Table ${table}` : ""}`, session);
      return waitView(updated);
    });
  }

  // ---------- Feedback ----------
  async function addFeedback(req, input) {
    // A receipt number only links the comment if that bill exists; a wrong number is simply dropped
    const bill = input.bill ? await db.collection("bills").findOne({ _id: input.bill }, { projection: { _id: 1 } }) : null;
    await feedback.insertOne({ rating: input.rating, comment: input.comment, name: input.name, billNo: bill ? bill._id : null, at: new Date() });
  }
  async function listFeedback() {
    const rows = await feedback.find().sort({ at: -1 }).limit(100).toArray();
    const all = await feedback.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]).toArray();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recent = await feedback.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]).toArray();
    return {
      average: all.length ? Math.round(all[0].avg * 10) / 10 : null, count: all.length ? all[0].n : 0,
      last30: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, (recent.find((x) => x._id === r) || { n: 0 }).n])),
      items: rows.map((f) => ({ rating: f.rating, comment: f.comment, name: f.name, billNo: f.billNo, at: f.at }))
    };
  }

  // Right to be forgotten: the member record keeps its totals but loses everything that identifies them
  async function eraseByPhone(phone, session) {
    const result = await customers.updateMany({ phoneIndex: blindIndex(phone, config.blindIndexKey) }, { $unset: { nameEnc: "", phoneEnc: "", phoneIndex: "" }, $set: { phoneMask: "", erasedAt: new Date() } }, { session });
    return result.modifiedCount;
  }

  return { enrol, lookup, list, history, earn, spend, reverse, listVouchers, createVoucher, setVoucherActive, redeemVoucher, listWaitlist, addWaiting, closeWaiting, addFeedback, listFeedback, eraseByPhone };
}

module.exports = { createGuestService };
