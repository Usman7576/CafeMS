# Deploying CafeMS

**CafeMS runs on any Linux server with Docker, and Caddy gets its HTTPS certificate automatically.** You need a server with at least 2 GB of memory, a domain name, and about 15 minutes. Netlify cannot host it, because it has no way to run the server or database.

## Before real customers use it

| Check | Why it matters |
| --- | --- |
| **Connect a real payment gateway, or take cash only** | The payment gateway is simulated, so Card and Wallet payments are marked Paid without any money moving |
| **Connect a real SMS or email provider if you want messages sent** | Receipts and staff notices are queued and logged, but nothing is actually delivered |
| **Decide how the database survives a server failure** | The stack runs one database on one server. Keep off-site backups, or use a three-member replica set or a managed database |
| **Consider flood protection such as Cloudflare** | The app limits requests, but a large attack needs protection before traffic reaches the server |

## Deploy

1. Point your domain's DNS A record at the server, and open only ports 22, 80 and 443 in its firewall.

2. Install Docker, then get the code:

```bash
git clone https://github.com/Usman7576/CafeMS.git && cd CafeMS
```

3. Generate the production settings, replacing the domain with yours. The passwords and keys go into `deploy/.env` and are never printed:

```bash
docker run --rm -v "$PWD:/app" -w /app node:24-trixie-slim node scripts/setup-env.js --production --domain cafe.example.com
```

4. Start the stack:

```bash
docker compose -f deploy/docker-compose.yml up -d --build --wait
```

5. Create the first Admin, using your own username and name. It prints a link that works once, within 24 hours:

```bash
docker compose -f deploy/docker-compose.yml run --rm app scripts/create-admin.js owner "Cafe Owner"
```

6. Open the link, set a password and enrol an authenticator app. Save the recovery codes somewhere safe. Then add your menu and invite your staff from the Admin screens.

## Back up, and test the backup

Keep a copy of `deploy/.env` somewhere safe and separate from the server. **Without it, the backups and encrypted customer data cannot be read.**

Take a backup:

```bash
docker compose -f deploy/docker-compose.yml run --rm backup
```

To run it every night at 03:00, add this line with `crontab -e`, using the full path to your copy:

```
0 3 * * * cd /home/you/CafeMS && docker compose -f deploy/docker-compose.yml run --rm -T backup
```

Copy the backups off the server regularly. They are encrypted, so they are safe to store elsewhere:

```bash
docker run --rm -v cafems-prod_backups:/from:ro -v "$PWD/offsite:/to" node:24-trixie-slim cp -r /from/. /to/
```

### Restore

The target database must be empty, so a restore cannot overwrite live records. On a new server, or after removing the damaged database, start the stack and then run:

```bash
docker compose -f deploy/docker-compose.yml run --rm restore /backups/YOUR-FILE.bak cafems
```

```bash
docker compose -f deploy/docker-compose.yml restart app
```

The same `deploy/.env` must be in place, because it holds the keys that decrypt the data. CI practises this whole recovery on every run.

## Update

```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build --wait
```

## Using a managed host instead

Render or Railway with MongoDB Atlas also works, since the `Dockerfile` runs anywhere and Atlas gives you a three-member replica set:

- Set the same variables as `deploy/.env`, with `NODE_ENV=production` and `TRUST_PROXY=1`.
- In Atlas, create a custom role with the privileges listed in `server/lib/dbRoles.js`, and a database user with only that role. Put its connection string in `MONGODB_URI`.
- Uploaded photos need a persistent disk mounted at `/data/uploads`.

## Checking a running server

```bash
docker compose -f deploy/docker-compose.yml ps
```

```bash
curl https://cafe.example.com/api/health/ready
```

Security alerts appear on the Admin Security page. The audit chain is verified every 15 minutes, and a broken chain raises an alert.
