# Running CafeMS locally (MongoDB on this computer, no Docker)

CafeMS needs Node.js 24 and a local **MongoDB server** (Community Server 8 or 9). MongoDB Compass is optional; it is only a viewer. No Docker is used.

## 1. Prepare MongoDB once (Administrator needed)

CafeMS uses **transactions** (orders, payments, requests and the audit log). MongoDB allows transactions only on a **replica set**, so the server runs as a single-node replica set named `rs0`. It also requires a login.

This computer is already set up like this, since 25 November 2026. The steps below are for a new computer.

1. Open `C:\Program Files\MongoDB\Server\<version>\bin\mongod.cfg` as Administrator and add:

   ```yaml
   replication:
     replSetName: rs0
   ```

2. Restart the **MongoDB** service (`services.msc` → MongoDB → Restart).

3. In Compass, connect to `mongodb://127.0.0.1:27017/?directConnection=true`, open the shell (`>_ MONGOSH` at the bottom) and run:

   ```js
   rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })
   ```

4. Create the administrator login. Use the `MONGO_ROOT_USERNAME` and `MONGO_ROOT_PASSWORD` from `.env`; run `npm run setup:env` first if `.env` does not exist yet.

   ```js
   db.getSiblingDB("admin").createUser({ user: "cafems_admin", pwd: "<MONGO_ROOT_PASSWORD from .env>", roles: ["root"] })
   ```

5. Turn on the login requirement. Create a key file (any 6–1024 base64 characters) at `C:\Program Files\MongoDB\Server\<version>\mongod.keyfile`, give `NETWORK SERVICE` read access, and add this to `mongod.cfg`. Use **single quotes**: in double quotes, YAML reads the backslashes as escape codes.

   ```yaml
   security:
     keyFile: 'C:\Program Files\MongoDB\Server\9.0\mongod.keyfile'
     authorization: enabled
   ```

   Restart the MongoDB service again.

After this, connecting without a login is refused, and every project on this server needs its own login.

## 2. Set up CafeMS

```bash
npm install
```

```bash
npm run setup
```

`npm run setup` does four things:
- creates any missing settings and keys in `.env`;
- checks the replica set;
- creates the app's limited database login (`cafems_app`), the collections and indexes;
- on an empty database, adds a demo cafe.

The staff usernames and their one-time passwords are written to `.seed-credentials.txt` (git-ignored). It is safe to run again.

```bash
npm start
```

Open http://localhost:3000. On first sign-in each person adds an authenticator app.

## 3. Look at the data in Compass

Connect with the administrator login (the password is `MONGO_ROOT_PASSWORD` in `.env`):

```
mongodb://cafems_admin:<password>@127.0.0.1:27017/?replicaSet=rs0&authSource=admin
```

The data is in the **cafems** database. Customer names and phone numbers, and authenticator secrets, are stored encrypted, and passwords only as Argon2id hashes. That is expected.

## Other projects on the same server

Login is required for the whole server. The `fraudguard` database has its own login. Its connection string is in `.local-mongo-logins.txt` (git-ignored); put it in that project's settings.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm start` | Start CafeMS on http://localhost:3000 |
| `npm run dev` | Start and restart automatically when code changes |
| `npm test` | All tests (they use a temporary in-memory MongoDB, never your data) |
| `npm run backup` | Encrypted backup of the database and photos into `backups/` |
| `npm run restore -- <file> <empty database>` | Restore a backup into an empty database |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `MongoDB is not running on 127.0.0.1:27017` | Start the **MongoDB** service in `services.msc` |
| `MongoDB must run as a replica set` | Do steps 1–3 of section 1 |
| `Authentication failed` | `.env` and the database logins differ: run `npm run setup` again; for the admin login, check `MONGO_ROOT_PASSWORD` |
| The MongoDB service will not start after editing `mongod.cfg` | A typo in the file. Check the single quotes around the key file path, or restore the `mongod.cfg.backup-…` copy beside it |
