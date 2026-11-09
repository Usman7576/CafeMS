// Development only: creates the staff accounts with random passwords, printed once. The database holds
// only their hashes. Each person enrols an authenticator at first sign-in.
require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const { loadConfig } = require("../server/config");
const { createClient, ensureIndexes, assertTransactionsAvailable } = require("../server/db");
const { seedCatalog } = require("./seed-data");
const { hashPassword } = require("../server/lib/passwords");

const STAFF = [
  { username: "m.usman", name: "M. Usman", role: "Waiter" },
  { username: "hina.malik", name: "Hina Malik", role: "Waiter" },
  { username: "chef.imran", name: "Imran Qureshi", role: "Kitchen" },
  { username: "bilal.ahmed", name: "Bilal Ahmed", role: "Cashier" },
  { username: "sara.khan", name: "Sara Khan", role: "Manager" },
  { username: "farah.admin", name: "Farah Siddiqui", role: "Admin" },
  { username: "zain.admin", name: "Zain Abbas", role: "Admin" }
];

function randomPassword() {
  return `${crypto.randomBytes(15).toString("base64url")}-aA1`;
}

async function main() {
  const config = loadConfig(process.env);
  if (config.isProduction) throw new Error("The development seed cannot run in production.");
  const client = createClient(config);
  await client.connect();
  try {
    const db = client.db(config.mongoDb);
    await assertTransactionsAvailable(db);
    await ensureIndexes(db);
    await seedCatalog(db);
    const users = db.collection("users");
    const base = { failedAttempts: 0, lockedUntil: null, createdAt: new Date(), mfa: { enabled: false } };

    for (const person of STAFF) {
      if (await users.findOne({ username: person.username })) {
        console.log(`${person.username.padEnd(14)} already exists, unchanged`);
        continue;
      }
      const password = randomPassword();
      await users.insertOne({ ...person, ...base, status: "Active", passwordHash: await hashPassword(password) });
      console.log(`${person.username.padEnd(14)} ${person.role.padEnd(8)} ${password}`);
    }
    if (!(await users.findOne({ username: "old.staff" }))) {
      await users.insertOne({ username: "old.staff", name: "Former Staff", role: "Waiter", ...base, status: "Disabled" });
    }
    console.log("\nSave these passwords now: they are not shown again.");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
