// Least privilege in the database: the app account can read and add audit entries, but never change or
// delete them, and it cannot create indexes on them (a time-to-live index would delete entries).
const READ_WRITE = ["find", "insert", "update", "remove"];
const COLLECTIONS = ["users", "sessions", "auth_challenges", "auth_tokens", "menu", "inventory", "orders", "bills", "reservations", "tables",
  "counters", "settings", "approvals", "idempotency", "audit_head", "alerts", "outbox", "notifications", "gateway_callbacks", "system_status", "signing_keys", "signed_actions", "passkeys", "passkey_challenges", "oidc_flows"];
const ROLE = "cafemsApp";

function appPrivileges(dbName) {
  const on = (collection, actions) => ({ resource: { db: dbName, collection }, actions });
  return [
    ...COLLECTIONS.map((name) => on(name, [...READ_WRITE, "createIndex"])),
    on("audit_events", ["find", "insert", "listIndexes"]),
    on("", ["listCollections", "createCollection"])
  ];
}

// Run with an administrator account. Safe to run again.
async function ensureAppRole(db) {
  const existing = await db.command({ rolesInfo: ROLE });
  const definition = { privileges: appPrivileges(db.databaseName), roles: [] };
  if (existing.roles.length) await db.command({ updateRole: ROLE, ...definition });
  else await db.command({ createRole: ROLE, ...definition });
}

async function ensureAppUser(db, username, password) {
  const existing = await db.command({ usersInfo: username });
  if (existing.users.length) await db.command({ updateUser: username, pwd: password, roles: [ROLE] });
  else await db.command({ createUser: username, pwd: password, roles: [ROLE] });
}

module.exports = { ensureAppRole, ensureAppUser, ROLE };
