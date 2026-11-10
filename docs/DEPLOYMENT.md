# Deploying CafeMS

**CafeMS runs on any Linux server with Docker, and Caddy gets its HTTPS certificate automatically.** You need a server with at least 3 GB of memory, a domain name, and about 15 minutes. Netlify cannot host it, because it has no way to run the server or database.

## Before real customers use it

| Check | Why it matters |
| --- | --- |
| **Connect a real payment gateway, or take cash only** | The payment gateway is simulated, so Card and Wallet payments are marked Paid without any money moving |
| **Connect a real SMS or email provider if you want messages sent** | Receipts and staff notices are queued and logged, but nothing is actually delivered |
| **Decide how the database survives a failure** | The default stack runs one database. Use the three-member option below, keep off-site backups, and use separate servers or a managed database to survive losing the whole machine |
| **Save the database encryption key** | Every database file is encrypted with AES-256-GCM using `deploy/.mongo-encryption-key`. Without that file the database cannot be read, so keep a copy away from the server |
| **Turn on your provider's disk encryption if you can** | The key file sits on the same server as the data, so disk encryption adds a layer if a whole disk is stolen |
| **Schedule nightly backups** | An alert appears on the Security page if no backup has succeeded for 26 hours |
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

5. Create **two** Admins for two different people, running this once for each. Each run prints a link that works once, within 24 hours. Two are needed because any change to an Admin needs a second Admin, and the command refuses after two:

```bash
docker compose -f deploy/docker-compose.yml run --rm app scripts/create-admin.js owner "Cafe Owner"
```

6. Open each link, set a password and enrol an authenticator app. Save the recovery codes somewhere safe. Then add your menu and invite your staff from the Admin screens.

An Admin can disable another Admin at once if that account is stolen. If an Admin is locked out or was wrongly disabled, whoever controls the server can restore them. This replaces their password and authenticator, and is recorded in the audit log:

```bash
docker compose -f deploy/docker-compose.yml run --rm app scripts/create-admin.js --recover owner
```

Give [STAFF-SECURITY-GUIDE.md](STAFF-SECURITY-GUIDE.md) to everyone who gets an account.

## Three database members (recommended)

Start a new deployment with the extra file below. If the primary stops, the other two elect a new one and the app carries on; in testing this took about 10 seconds. On one machine it covers a failed database process or volume. To survive losing the machine, put the members on separate servers or use a managed database.

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.ha.yml up -d --build --wait
```

Use both `-f` options on every later `docker compose` command too.

## Back up, and test the backup

Keep a copy of `deploy/.env` and `deploy/.mongo-encryption-key` somewhere safe and separate from the server. **Without them, the backups and encrypted data cannot be read.**

Take a backup:

```bash
docker compose -f deploy/docker-compose.yml run --rm backup
```

To run it every night at 03:00, add this line with `crontab -e`, using the full path to your copy:

```
0 3 * * * cd /home/you/CafeMS && docker compose -f deploy/docker-compose.yml run --rm -T backup
```

Each run deletes backups older than 30 days from this folder, so erased customer data does not live on in them. Delete your off-site copies on the same schedule. Copy the backups off the server regularly. They are encrypted, so they are safe to store elsewhere:

```bash
docker run --rm -v cafems-prod_backups:/from:ro -v "$PWD/offsite:/to" node:24-trixie-slim cp -r /from/. /to/
```

### Restore

The target database must be empty, so a restore cannot overwrite live records. On a new server, or after removing the damaged database, start the stack and then run:

```bash
docker compose -f deploy/docker-compose.yml run --rm restore /backups/YOUR-FILE.bak cafems
```

```bash
docker compose -f deploy/docker-compose.yml restart app app-staff
```

The same `deploy/.env` must be in place, because it holds the keys that decrypt the data. The restore fails if the audit chain does not verify. If you erased a customer's data after that backup was made, erase it again. CI practises this whole recovery on every run.

## Web application firewall

Caddy is built with Coraza, which runs the OWASP Core Rule Set and blocks requests that look like SQL injection, cross-site scripting or path traversal with a 403. It also limits each address to 900 requests a minute, and 60 a minute to the sign-in pages. The first build compiles Caddy and takes several minutes. Blocked requests are written to Caddy's log; see them with `docker compose -f deploy/docker-compose.yml logs caddy`. If staff are wrongly blocked, find the rule number in that log and add a narrow exception in `deploy/Caddyfile`, as is done for menu photos.

## Optional sign-in and email settings

Add these to `deploy/.env` only if you use them, then run the update command:

| Setting | Purpose |
| --- | --- |
| `SMTP_URL`, `MAIL_FROM`, `STAFF_NOTIFY_EMAIL` | Email staff about new online bookings. Mail is sent only over TLS 1.2 or later to a server with a valid certificate. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Let staff sign in with an organisation account (Google, Microsoft and others). Register `https://your-domain/api/v1/auth/oidc/callback` with the provider. Each person links their account on the Account page, and the cafe's own code or passkey is still asked for. |

Staff can also add a passkey on the Account page, to sign in with a fingerprint, face or device PIN.

## Review the audit log every week

The Admin opens the Audit page, reads the week's entries, follows up anything unexpected and clicks **Mark as reviewed**. The review is recorded, and a reminder appears on the Security page if none has been recorded for 7 days.

## Update

```bash
git pull && docker compose -f deploy/docker-compose.yml up -d --build --wait
```

## Using a managed host instead

Render or Railway with MongoDB Atlas also works, since the `Dockerfile` runs anywhere and Atlas gives you a three-member replica set:

- Set the same variables as `deploy/.env`, with `NODE_ENV=production` and `TRUST_PROXY=1`.
- In Atlas, create a custom role with the privileges listed in `server/lib/dbRoles.js`, and a database user with only that role. Put its connection string in `MONGODB_URI`.
- Uploaded photos need a persistent disk mounted at `/data/uploads`.

## Using Cloudflare or another CDN

A service in front of Caddy adds a second proxy, and every visitor would otherwise appear to come from its few addresses, so one attacker could use up everyone's rate limit. Make two changes:

1. In `deploy/Caddyfile`, add this inside the block at the top, replacing the addresses with your provider's published ranges:

```
servers {
	trusted_proxies static 173.245.48.0/20 103.21.244.0/22
}
```

2. Add `TRUST_PROXY=2` to `deploy/.env`, then run the update command above.

## Checking a running server

```bash
docker compose -f deploy/docker-compose.yml ps
```

```bash
curl https://cafe.example.com/api/health/ready
```

Security alerts appear on the Admin Security page. The audit chain is verified every 15 minutes, and a broken chain raises an alert.
