// Usage: node scripts/create-admin.js <username> "<Full name>"
//        node scripts/create-admin.js --recover <username>
// In the production stack:
//   docker compose -f deploy/docker-compose.yml run --rm app scripts/create-admin.js owner "Cafe Owner"
//
// Creates the first two Admins of a deployment as invitations, and prints a single-use, 24-hour setup
// link once. Two are needed before the second-Admin rule can work. It refuses once two Admins exist, so
// it cannot be used to add more behind that rule. --recover restores an existing Admin who was locked
// out or wrongly disabled, replacing their password and authenticator. Both need access to the server
// itself, and both are written to the audit log.
require("dotenv").config({ quiet: true });
const { loadConfig } = require("../server/config");
const { createClient, ensureIndexes } = require("../server/db");
const { randomToken, hashToken } = require("../server/lib/crypto");
const { inTransaction } = require("../server/lib/tx");
const { bindAudit, recordEvent } = require("../server/services/auditLog");

const USERNAME = /^[a-z][a-z0-9._]{2,29}$/;

(async () => {
  const recovering = process.argv[2] === "--recover";
  const [username, ...nameParts] = process.argv.slice(recovering ? 3 : 2);
  const name = nameParts.join(" ").trim();
  if (!USERNAME.test(username || "") || (!recovering && (name.length < 2 || name.length > 60))) {
    throw new Error('Give a username (3-30 lower-case letters, numbers, dots or underscores) and a full name, for example: owner "Cafe Owner"');
  }
  const config = loadConfig(process.env);
  const client = createClient(config);
  await client.connect();
  try {
    const db = client.db(config.mongoDb);
    await ensureIndexes(db);
    bindAudit(db, config);
    const token = randomToken(32);
    await inTransaction(db, async (session) => {
      const users = db.collection("users");
      const tokens = db.collection("auth_tokens");
      if (recovering) {
        const target = await users.findOne({ username, role: "Admin" }, { session });
        if (!target) throw new Error("There is no Admin with that username.");
        await users.updateOne({ username }, {
          $set: { status: "Invited", failedAttempts: 0, lockedUntil: null, sponsor: "setup", mfa: { enabled: false } }, $unset: { passwordHash: "" }
        }, { session });
        await db.collection("sessions").deleteMany({ username }, { session });
        await db.collection("auth_challenges").deleteMany({ username }, { session });
        await tokens.deleteMany({ username }, { session });
      } else {
        if (await users.countDocuments({ role: "Admin", status: { $ne: "Disabled" } }, { session }) >= 2) {
          throw new Error("Two Admins already exist. Ask them to invite new staff from the Staff & roles page.");
        }
        if (await users.findOne({ username }, { session })) throw new Error("That username is already taken.");
        await users.insertOne({
          username, name, role: "Admin", status: "Invited", failedAttempts: 0, lockedUntil: null,
          createdAt: new Date(), createdBy: "setup", sponsor: "setup", mfa: { enabled: false }
        }, { session });
      }
      await tokens.insertOne({
        _id: hashToken(token), username, purpose: recovering ? "reset" : "invitation", createdBy: "setup", expiresAt: new Date(Date.now() + config.auth.setupTokenMs)
      }, { session });
      await recordEvent(db, null, { actor: "setup", action: recovering ? "Admin recovered from the server" : "Admin invited from the server", details: username, severity: "high" }, { session });
    });
    console.log(`${recovering ? "Recovery" : "Invitation"} link for ${username}. Open it within 24 hours; it works once:`);
    console.log(`${config.appOrigin}/setup.html#token=${token}`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Could not set up the Admin: ${error.message}`);
  process.exit(1);
});
