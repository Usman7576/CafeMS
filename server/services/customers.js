// Personal data lifecycle: erasure on request (right to be forgotten) and automatic retention limits.
// Financial totals stay, because tax records must be kept; only what identifies the customer goes.
const { blindIndex } = require("../lib/crypto");
const { localDate } = require("../lib/domain");
const { recordEvent } = require("./auditLog");

const ERASE_BILL = { $unset: { phoneEnc: "", phoneIndex: "", phoneMask: "" }, $set: { customerErasedAt: new Date() } };
const eraseReservation = () => ({
  $unset: { nameEnc: "", phoneEnc: "", phoneIndex: "", notesEnc: "" },
  $set: { phoneMask: "", erasedAt: new Date(), active: false }
});

function createCustomerService({ config, db }) {
  async function erase(req, phone, session) {
    const index = blindIndex(phone, config.blindIndexKey);
    const bills = await db.collection("bills").updateMany({ phoneIndex: index }, ERASE_BILL, { session });
    const reservations = await db.collection("reservations").updateMany({ phoneIndex: index }, eraseReservation(), { session });
    // The record of the erasure holds counts only, never the number that was erased
    await recordEvent(db, req, {
      actor: req.auth.user.username, role: req.auth.user.role, action: "Customer data erased",
      details: `${bills.modifiedCount} bills, ${reservations.modifiedCount} reservations`, severity: "high"
    }, { session });
    return { bills: bills.modifiedCount, reservations: reservations.modifiedCount };
  }

  return { erase };
}

// Worker: removes personal data once it has passed the retention period
async function purgeExpiredData(db, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const bills = await db.collection("bills").updateMany({ createdAt: { $lt: cutoff }, phoneEnc: { $exists: true } }, ERASE_BILL);
  const reservations = await db.collection("reservations").updateMany(
    { date: { $lt: localDate(cutoff.getTime()) }, erasedAt: { $exists: false } },
    eraseReservation()
  );
  return { bills: bills.modifiedCount, reservations: reservations.modifiedCount };
}

module.exports = { createCustomerService, purgeExpiredData };
