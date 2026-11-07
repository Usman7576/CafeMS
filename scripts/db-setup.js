// Usage: npm run db:setup
// Creates the database accounts. The administrator account is used only here; the app signs in with
// its own account, whose role (server/lib/dbRoles.js) can read and add audit entries but never change
// or delete them. Safe to run again. Passwords come from .env and are never printed.
require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");
const { ensureAppRole, ensureAppUser, ROLE } = require("../server/lib/dbRoles");

const HOST = process.env.MONGODB_HOST || "127.0.0.1:27018";
const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env. Run: npm run setup:env`);
  return value;
};

async function connect(withLogin) {
  const login = withLogin ? `${encodeURIComponent(need("MONGO_ROOT_USERNAME"))}:${encodeURIComponent(need("MONGO_ROOT_PASSWORD"))}@` : "";
  const client = new MongoClient(`mongodb://${login}${HOST}/?directConnection=true&authSource=admin`, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  return client;
}

(async () => {
  const rootUser = need("MONGO_ROOT_USERNAME");
  const rootPassword = need("MONGO_ROOT_PASSWORD");
  const appUser = need("MONGODB_APP_USERNAME");
  const appPassword = need("MONGODB_APP_PASSWORD");
  const dbName = process.env.MONGODB_DB || "cafems";

  let client;
  try {
    client = await connect(true);
  } catch (error) {
    // A database that has never had a login (older setups) accepts a connection without one, once,
    // so the administrator account can be created. After that, access control is switched on.
    client = await connect(false);
    const admin = client.db("admin");
    if (!(await admin.command({ usersInfo: rootUser })).users.length) {
      await admin.command({ createUser: rootUser, pwd: rootPassword, roles: ["root"] });
      console.log(`Created the administrator account "${rootUser}".`);
    }
  }
  try {
    const db = client.db(dbName);
    await ensureAppRole(db);
    await ensureAppUser(db, appUser, appPassword);
    console.log(`The app account "${appUser}" has the least-privilege role "${ROLE}" on "${dbName}".`);
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(`Database setup failed: ${error.message}`);
  process.exit(1);
});
