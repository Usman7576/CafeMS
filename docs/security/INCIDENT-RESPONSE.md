# Incident response

**When something looks wrong: preserve the evidence, stop the damage, then restore from a known good state.** If personal data may have been exposed, the 72-hour notification clock starts when you become aware of it.

Commands assume the production stack; `C` stands for `docker compose -f deploy/docker-compose.yml`.

## Who does what

| Role | Who | Responsibility |
| --- | --- | --- |
| Incident lead | Cafe owner | Decides on shutdown and notifications; speaks for the cafe |
| Technical lead | An Admin | Investigates, contains and restores; keeps the timeline |
| Second Admin | Another Admin | Approves Admin changes during the incident, checks the work |

Keep a written timeline from the first minute: what was seen, what was done, by whom and when.

## How incidents are detected

| Signal | Where it appears |
| --- | --- |
| Failed sign-ins, from one account or one address | Admin Security page |
| Repeated access denials | Admin Security page |
| Unusual exports, number views or refunds | Admin Security page |
| A bill possibly paid twice, or refused gateway callbacks | Admin Security page |
| Audit chain broken | Admin Security page; checked every 15 minutes |
| Messages not being delivered | Admin Security page |
| The site is slow or down | Health check at `/api/health/ready`; container status with `C ps` |
| A person reports something | Staff, a customer or the repository's private vulnerability report |

## Severity

| Level | Meaning | Respond within |
| --- | --- | --- |
| Critical | Personal data or money taken, audit log altered, Admin account taken over | At once |
| High | One staff account taken over, a site outage during service | 1 hour |
| Medium | Repeated attacks that were blocked, a suspected insider | Same day |
| Low | A single unusual event | Next working day |

## The six stages

1. **Prepare.** Keep `deploy/.env` and off-site backups separate from the server. Make sure at least two people hold Admin accounts. Practise a restore: CI does so on every run.
2. **Identify.** Confirm the alert in the audit log. Note who, what, when and from which address. Run the chain check from the Audit page.
3. **Contain.** Use the playbook below. Save the evidence **before** changing anything:

   ```bash
   docker compose -f deploy/docker-compose.yml logs --no-color > incident-logs.txt
   ```

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm backup
   ```

4. **Eradicate.** Remove the cause: patch the flaw, disable the account, rotate exposed keys.
5. **Recover.** Restore if needed, confirm the audit chain verifies, and watch the Security page closely for 48 hours.
6. **Learn.** Within a week, write what happened and why. Add a test that fails on the old behaviour, update the risk register and record it in the review log in `SECURITY-REQUIREMENTS.md`.

## Playbooks

### A staff account is taken over
1. An Admin opens Staff & roles and disables the account. This ends its sessions at once.
2. Review that account's actions in the audit log.
3. Reverse any damage, such as refunds or price changes.
4. Use a reset link so the person sets a new password and enrols a new authenticator, then enable the account.

### An Admin account is taken over
1. A second Admin disables it. Any change affecting an Admin needs a second Admin, so one stolen account cannot quietly add another.
2. If no Admin can sign in, stop the app with `C stop app caddy`, then investigate the database directly.
3. Check for pending approvals and reject any you do not recognise.

### Suspected insider
1. Do not alert the person first. Preserve the logs and take a backup.
2. Review exports, full-number views, refunds and discounts for that account.
3. The incident lead decides on disabling the account and any further action.

### Personal data exposed
Follow the [72-hour steps](#personal-data-breach-the-72-hour-steps) below, after containing the cause.

### The audit log fails its check
1. Treat this as Critical: someone may have altered the database. Do not acknowledge the alert until the evidence is saved.
2. Compare the alert's entry number with the last "Audit chain verified" hash in the application logs, which are kept outside the database.
3. Compare with the most recent backup that verifies, to find what changed.

### Ransomware, or a server or database lost
1. Disconnect the server. Do not pay, and do not reuse the machine.
2. Build a new server from `docs/DEPLOYMENT.md`, using the saved `deploy/.env`.
3. Restore the latest good off-site backup; backups are encrypted and carry a checksum, so a damaged or altered file is refused.
4. Rotate every key and password, because the old server's secrets must be assumed stolen.

### Site overwhelmed by traffic
1. Check `C ps` and the logs. Staff requests have their own per-person limit.
2. Put a service such as Cloudflare in front of the domain, or ask the host to filter the traffic.

### A vulnerable dependency is announced
1. Check Dependabot and the CI scan results.
2. Update, run `npm test`, redeploy, and check the logs for signs it was used against you.

## Rotating keys

Edit `deploy/.env`, then apply the change with `docker compose -f deploy/docker-compose.yml up -d`.

| Secret | How to rotate | Effect |
| --- | --- | --- |
| `JWT_KEYS` | Add `k2:<new key>`, set `JWT_ACTIVE_KEY=k2`, and remove `k1` | Removing the old key signs everyone out, which is what you want after a theft |
| `DATA_KEYS` | Add a new key and make it active; **keep the old one** | New data uses the new key; old data still reads. Deleting an old key makes its data unreadable |
| `AUDIT_KEYS` | Add a new key and make it active; **keep the old one** | Old entries must still verify |
| `GATEWAY_SECRET` | Change it together with the payment provider | Callbacks signed with the old secret are refused |
| `BACKUP_KEY` | Keep the old key for old backups, and take a new backup | Each backup needs the key it was made with |
| Database passwords | Change the password in MongoDB and in `deploy/.env` | The app reconnects with the new one |
| `BLIND_INDEX_KEY` | Cannot be swapped without re-indexing every number; plan this with a developer | Phone search stops matching old records |

Generate a new key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Personal data breach: the 72-hour steps

The Week 4 requirement follows GDPR's 72-hour rule. Take local legal advice on what applies to your cafe, then:

| Deadline | Step |
| --- | --- |
| Hour 0 | Note the time you became aware. Start the timeline |
| Within 24 hours | Establish what data, how many customers, and whether it was encrypted. Stored names, numbers and notes are encrypted, so the key question is whether the keys were exposed too |
| Within 72 hours | Notify the relevant data protection authority, if the law requires it. If some facts are unknown, send what you know and follow up |
| Without delay, if the risk to people is high | Tell the affected customers directly |
| Afterwards | Keep the record of the breach, even if notification was not required |

The notice should say what happened and when, what data was involved and how many people, the likely consequences, what you have done, and who to contact.
