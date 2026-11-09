// Usage: node scripts/create-admin.js <username> "<Full name>"
// In the production stack:
//   docker compose -f deploy/docker-compose.yml run --rm app scripts/create-admin.js owner "Cafe Owner"
//
// Creates the FIRST Admin of a new deployment as an invitation, and prints a single-use, 24-hour setup
// link once. The person opens it, sets a password and enrols an authenticator, exactly like any other
// invited member of staff. It refuses to run if any Admin already exists, so it cannot be used to add
// an Admin behind the second-Admin approval rule.
require("dotenv").config({ quiet: true });
const { loadConfig } = require("../server/config");
const { createClient, ensureIndexes } = require("../server/db");
const { randomToken, hashToken } = require("../server/lib/crypto");
const { inTransaction } = require("../server/lib/tx");
const { bindAudit, recordEvent } = require("../server/services/auditLog");

const USERNAME = /^[a-z][a-z0-9._]{2,29}$/;

(async () => {
  const [username, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(" ").trim();
  if (!USERNAME.test(username || "") || name.length < 2 || name.length > 60) {
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
      if (await db.collection("users").findOne({ role: "Admin", status: { $ne: "Disabled" } }, { session })) {
        throw new Error("An Admin already exists. Ask them to invite new staff from the Staff & roles page.");
      }
      if (await db.collection("users").findOne({ username }, { session })) throw new Error("That username is already taken.");
      await db.collection("users").insertOne({
        username, name, role: "Admin", status: "Invited", failedAttempts: 0, lockedUntil: null,
        createdAt: new Date(), createdBy: "setup", mfa: { enabled: false }
      }, { session });
      await db.collection("auth_tokens").insertOne({
        _id: hashToken(token), username, purpose: "invitation", createdBy: "setup", expiresAt: new Date(Date.now() + config.auth.setupTokenMs)
      }, { session });
      await recordEvent(db, null, { actor: "setup", action: "First Admin invited", details: username, severity: "high" }, { session });
    });
    console.log(`Invitation created for ${username}. Open this link within 24 hours; it works once:`);
    console.log(`${config.appOrigin}/setup.html#token=${token}`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Could not create the first Admin: ${error.message}`);
  process.exit(1);
});
