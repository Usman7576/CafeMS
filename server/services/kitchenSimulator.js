// Demonstration aid: advances orders when no kitchen user is signed in. It runs on the server, is
// off unless an Admin turns it on, and stands aside as soon as kitchen staff are present.
const TO_PREPARING_MS = 10 * 1000;
const TO_READY_MS = 20 * 1000;
const KITCHEN_PRESENT_MS = 5 * 60 * 1000;

async function tickKitchen(db) {
  const settings = await db.collection("settings").findOne({ _id: "app" });
  if (!settings || settings.kitchenSim !== true) return 0;

  const now = Date.now();
  const staffPresent = await db.collection("sessions").countDocuments({ role: "Kitchen", lastSeenAt: { $gt: new Date(now - KITCHEN_PRESENT_MS) } });
  if (staffPresent) return 0;

  const orders = db.collection("orders");
  const stamp = { updatedAt: new Date(now) };
  const ready = await orders.updateMany({ status: "Preparing", updatedAt: { $lte: new Date(now - TO_READY_MS) } }, { $set: { status: "Ready", ...stamp }, $inc: { version: 1 } });
  const preparing = await orders.updateMany({ status: "Placed", updatedAt: { $lte: new Date(now - TO_PREPARING_MS) } }, { $set: { status: "Preparing", ...stamp }, $inc: { version: 1 } });
  return ready.modifiedCount + preparing.modifiedCount;
}

module.exports = { tickKitchen };
