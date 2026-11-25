// Usage: npm run setup
// One command to get CafeMS ready on this computer, against the local MongoDB server:
//   1. adds any missing settings and keys to .env (existing values are kept)
//   2. checks MongoDB is running on MONGODB_HOST as a replica set (transactions need one)
//   3. creates the app's least-privilege login, the collections and indexes (npm run db:setup)
//   4. on an empty database, adds the demo cafe and saves the new staff passwords to .seed-credentials.txt
// Safe to run again. Nothing secret is printed.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const run = (script, opts = {}) => execFileSync(process.execPath, [path.join(__dirname, script)], { cwd: ROOT, encoding: "utf8", stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
const fail = (message) => { console.error(`\nSetup stopped: ${message}`); process.exit(1); };

(async () => {
  console.log("1/4  Settings (.env)");
  run("setup-env.js");
  require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
  const { MongoClient } = require("mongodb");

  console.log("2/4  Local MongoDB");
  const host = process.env.MONGODB_HOST || "127.0.0.1:27017";
  const login = `${encodeURIComponent(process.env.MONGO_ROOT_USERNAME)}:${encodeURIComponent(process.env.MONGO_ROOT_PASSWORD)}@`;
  let client;
  try {
    client = await MongoClient.connect(`mongodb://${login}${host}/?directConnection=true&authSource=admin`, { serverSelectionTimeoutMS: 4000 });
    await client.db("admin").command({ ping: 1 });
  } catch (error) {
    if (/ECONNREFUSED|Server selection timed out/i.test(error.message)) fail(`MongoDB is not running on ${host}. Start the "MongoDB" Windows service (services.msc), then run this again.`);
    // A server with no logins yet accepts a connection without one; db:setup then creates the administrator
    client = await MongoClient.connect(`mongodb://${host}/?directConnection=true`, { serverSelectionTimeoutMS: 4000 });
  }
  const hello = await client.db("admin").command({ hello: 1 });
  let users = 0;
  try { users = await client.db(process.env.MONGODB_DB || "cafems").collection("users").estimatedDocumentCount(); } catch { users = 0; }
  await client.close();
  if (!hello.setName) fail("MongoDB is running, but not as a replica set, so transactions are not available. Follow docs/LOCAL-SETUP.md (step 1), then run this again.");
  console.log(`     MongoDB at ${host}, replica set ${hello.setName}`);

  console.log("3/4  Database login, collections and indexes");
  run("db-setup.js");

  console.log("4/4  Demo data");
  if (users > 0) {
    console.log("     The database already has staff accounts: menu, stock and photos are topped up, accounts are left as they are.");
    run("seed-dev.js", { capture: true });
  } else {
    const file = path.join(ROOT, ".seed-credentials.txt");
    // An old file belongs to an earlier database, so it is kept beside the new one rather than replaced
    if (fs.existsSync(file)) fs.renameSync(file, path.join(ROOT, `.seed-credentials.${Date.now()}.old.txt`));
    fs.writeFileSync(file, run("seed-dev.js", { capture: true }), { mode: 0o600 });
    console.log("     Demo cafe created. Staff usernames and their one-time passwords are in .seed-credentials.txt");
  }
  console.log("\nReady. Start CafeMS with: npm start   (then open http://localhost:3000)");
})().catch((error) => fail(error.message));
