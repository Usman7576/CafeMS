# Concept coverage

**All 116 concepts from the eight lecture decks are accounted for: 94 built and tested, 17 written analyses, 1 manual procedure and 4 that cannot be built inside a web app.**

Generated from `concept-coverage.json` by `npm run concepts`; do not edit by hand. A test fails if a file or test named here stops existing, or if this page is out of date.

## SSD Lec1

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 2-3, 8 | Attack surface created by each feature | Documented | Every feature is analysed for how it can be abused | `docs/security/THREAT-MODEL.md`, `docs/security/TRACEABILITY.md` | – |
| 7, 9 | Secure SDLC: security throughout, because late fixes cost more | Built | Requirements, threat model, code, tests, scans and CI run together on every change | `.github/workflows/ci.yml`, `docs/security/SECURITY-REQUIREMENTS.md` | CI runs every tool the plan names |
| 16 | Web architecture | Built | Browser, API, database and proxy tiers, with a guarded route for everything | `server/app.js`, `deploy/docker-compose.yml` | every route has a guard, so none can be left open by accident (complete mediation) |
| 16 | Git and version control | Built | Feature branch, reviewed commits and secret scanning of the whole history | `.gitleaksignore`, `.github/pull_request_template.md`, `.github/workflows/ci.yml` | generated secrets stay out of git |
| 16 | Registration | Built | Admin invitation with a single-use, 24-hour link that sets a password and MFA | `server/services/users.js`, `server/routes/auth.js` | the whole flow: invite, set password, enrol, sign in; a link works once, and only its hash is stored |
| 27 | Password hashing | Built | Argon2id | `server/lib/passwords.js` | passwords are stored only as Argon2id hashes |
| 27 | Login and logout | Built | Server-side sign-in and revocable sign-out | `server/routes/auth.js` | a wrong password is refused, even though it meets the rules (finding 1); sign-out ends the session on the server, so a copied cookie stops working |
| 27 | Sessions | Built | Server session record checked on every request; 5-minute idle and 8-hour limits | `server/services/sessions.js` | 5 idle minutes end the session; the 8-hour limit applies however active the session is |
| 27 | JWT | Built | Signed token with a pinned algorithm and key ID | `server/services/sessions.js` | forged tokens are refused: alg none, wrong key, no server record |
| 27 | MFA | Built | TOTP for all staff, with single-use recovery codes | `server/services/mfa.js` | a correct password alone gives no session (MFA is mandatory); a code cannot be used twice; a recovery code works exactly once |
| 27 | Secure cookies | Built | __Host- prefix, HttpOnly, Secure, SameSite=Strict | `server/services/sessions.js` | a correct code creates a session and sets a hardened cookie |
| 27 | Brute-force protection | Built | Per-account lockout, per-address rate limit, alerts | `server/routes/auth.js`, `server/app.js` | 3 failures lock the account, and the right password is then refused; the auth rate limit stops rapid guessing across accounts |
| 28 | Roles and RBAC | Built | One permission table | `server/lib/permissions.js` | every role against every route (RBAC matrix) |
| 28 | Middleware | Built | requireAuth, requirePermission and requireStepUp on the routes | `server/middleware/auth.js` | every route has a guard, so none can be left open by accident (complete mediation) |
| 28 | Least privilege | Built | Role-filtered responses and a restricted database account | `server/routes/business.js`, `server/lib/dbRoles.js` | the snapshot holds only that role's data; the app account can add audit entries but cannot change or delete them |
| 28, 31 | Resource-level authorization | Built | Ownership inside every query | `server/services/orders.js` | one waiter cannot see or change another waiter's order |
| 16, 29 | Prepared statements and SQL injection | Built | MongoDB's equivalent: typed filters from strictly validated input, so query operators cannot be injected | `server/lib/schemas.js`, `server/middleware/auth.js` | NoSQL operator objects are refused |
| 29 | Encryption | Built | AES-256-GCM on every database file (Percona Server for MongoDB), plus field encryption with key IDs for customer details | `server/lib/crypto.js`, `docs/security/RESIDUAL-RISKS.md`, `docs/DEPLOYMENT.md`, `deploy/docker-compose.yml`, `scripts/setup-env.js` | name, phone and notes are encrypted at rest; the data cannot be read after being moved to another record; a shortened GCM authentication tag is refused, so forged values cannot be accepted; every database file is encrypted at rest with AES-256, and the key stays out of git and the image |
| 29 | Secure database access | Built | Database requires a login, on a private network, with a least-privilege account | `server/lib/dbRoles.js`, `scripts/db-setup.js`, `deploy/docker-compose.yml` | only Caddy is reachable from outside, and the database network has no route out; production refuses a database connection with no username and password (least privilege) |
| 29 | Backup | Built | Encrypted backup with a checksum and a tested restore | `server/lib/backup.js` | a restore brings back every record, and the audit chain still verifies; the backup file holds no readable data |
| 31 | Integrity: total changed from Rs 2,500 to 250 | Built | Totals worked out on the server from stored prices | `server/services/billing.js`, `server/lib/domain.js` | the total is calculated on the server; the browser cannot set it (Rs 2,500 to 250) |
| 31 | Confidentiality: another customer's address | Built | Encryption, masking and ownership checks | `server/services/reservations.js` | stored encrypted, and masked in every response |
| 31 | Availability: thousands of requests | Built | Limits per address, per person and for pages; body limits; timeouts | `server/app.js`, `server/index.js`, `scripts/load-test.js` | the general API rate limit applies; oversized bodies are refused |
| 16 | XSS | Built | All text rendered as text, never as HTML | `public/js/common.js` | script text in a name is stored as plain text, and shown as plain text |
| 16 | DOM security | Built | No innerHTML anywhere, enforced by Trusted Types | `public/js/common.js`, `server/middleware/security.js` | no browser script writes HTML from strings or stores business data on the device (findings 14, 20, 30) |
| 16 | CSP | Built | Strict policy with no inline code or outside hosts | `server/middleware/security.js` | the CSP has no exceptions: no inline styles, no third-party hosts, Trusted Types required |
| 16 | REST APIs | Built | Versioned API under /api/v1 | `server/routes/business.js` | every role against every route (RBAC matrix) |
| 16 | API security | Built | Authentication, permissions, strict schemas, CSRF, rate limits and idempotency | `server/app.js`, `server/lib/tx.js` | a signed-in change needs the CSRF token; requests from another site, or with no Origin, are blocked; an order needs an Idempotency-Key |
| 8, 16 | File security and malicious uploads | Built | Signature check, 2 MB limit, random name, outside the web root, nosniff; every image decoded and rebuilt, removing hidden content and metadata | `server/services/photos.js` | scripts, SVG, HTML and disguised files are refused and recorded; a file over 2 MB is refused; a real image is stored outside the web root under a random name, and served safely; content hidden after a real image, and its metadata, do not survive |
| 8 | Error messages leaking information | Built | Central handler: generic message and a request ID | `server/app.js` | broken JSON gives a clean error with no stack trace |
| 16 | Code review | Documented | Dated independent review with every finding and outcome, and a pull request security checklist | `docs/security/CODE-REVIEW.md`, `.github/pull_request_template.md` | – |
| 16 | SAST | Built | ESLint security rules, Semgrep and CodeQL | `eslint.config.js`, `.github/workflows/ci.yml`, `docs/security/SCAN-RESULTS.md` | CI runs every tool the plan names |
| 16 | DAST and OWASP ZAP | Built | Passive scan, plus an active scan of the signed-in API against the running stack | `.zap/rules.tsv`, `.zap/sign-in.js`, `scripts/openapi.js`, `.github/workflows/ci.yml`, `docs/security/SCAN-RESULTS.md` | CI runs every tool the plan names |
| 16 | Burp Suite | Manual | All 30 listed attacks sent through Burp Suite's proxy and refused, and replayed automatically on every CI run; hand testing in Repeater has not been done | `docs/security/BURP-TEST-SCRIPT.md`, `scripts/attack-replay.js`, `docs/security/ATTACK-REPLAY-RESULTS.md` | – |
| 16 | Dependency scanning | Built | npm audit, Trivy and Dependabot | `.github/dependabot.yml`, `.github/workflows/ci.yml` | the packages npm audit flagged are on fixed versions (finding 17) |
| 16 | Docker | Built | Multi-stage, non-root, read-only image | `Dockerfile`, `deploy/docker-compose.yml` | runs on a pinned, minimal base as an unprivileged user; every service is read-only, drops all capabilities and cannot gain privileges |
| 16 | CI/CD | Built | GitHub Actions on every push, with pinned actions | `.github/workflows/ci.yml`, `.github/workflows/release.yml` | every action is pinned to a commit, and the default token is read-only |
| 16 | HTTPS and TLS | Built | Caddy certificates, HSTS, https required in production | `deploy/Caddyfile`, `server/config.js` | HSTS is sent when the site uses TLS; production requires https |
| 16 | Secrets management | Built | Validated at start-up, key IDs for rotation, never in git or the image | `server/config.js`, `scripts/setup-env.js` | refuses to start without secrets; error messages never contain secret values; installs locked production packages only and copies no secrets, tests or git history |
| 16 | Monitoring | Built | Redacted logs with request IDs, alert rules and an Admin Security page | `server/services/alerts.js`, `server/lib/logger.js`, `public/security.html` | failed sign-ins, denials, exports, number views and refunds each raise an alert; logs hold no cookies, tokens, passwords or codes |
| 16 | Incident response | Documented | Runbook with roles, playbooks and the 72-hour breach steps | `docs/security/INCIDENT-RESPONSE.md` | – |

## Week 2

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 8-9 | Confidentiality | Built | Each role receives only its own fields; personal data encrypted | `server/routes/business.js`, `server/lib/crypto.js` | the snapshot holds only that role's data; name, phone and notes are encrypted at rest |
| 10-11 | Integrity, hashing and version control | Built | Server-side rules, transactions, SHA-256 audit chain, Git | `server/services/auditLog.js`, `server/lib/tx.js` | if any step fails, nothing is saved; detects edited details, a changed actor and a changed time |
| 12-13 | Availability, redundancy and failover | Built | Throttling, health checks, graceful shutdown, and a three-member database option proved by a failover drill | `server/app.js`, `server/lifecycle.js`, `deploy/docker-compose.ha.yml`, `.github/workflows/ci.yml` | the public health checks reveal status only (finding 18); a request in progress finishes, then the database closes and the process exits cleanly; the three-member database option has three members, and the app can reach them all |
| 14-15 | Accountability and non-repudiation | Built | Actor taken from an MFA-verified session and an Ed25519-signed audit chain; refunds, approvals, staff changes and erasure also carry the person's own ECDSA P-256 device signature, kept and re-checkable | `server/services/auditLog.js`, `docs/security/RESIDUAL-RISKS.md`, `server/services/signatures.js`, `public/js/common.js` | the recorded waiter is always the signed-in person; detects a recalculated hash, because the attacker cannot sign it; an unsigned staff change is refused and nothing changes; a signed change goes through, and the signature is kept and recorded; a captured signed request cannot be replayed; a signature over a changed body, another person's key, a removed key or an old time is refused; every kept signature verifies, and a changed record is found |
| 16-17 | Authentication | Built | Password plus MFA | `server/routes/auth.js` | a correct password alone gives no session (MFA is mandatory) |
| 22-23 | Least privilege | Built | Permission table, role-filtered data, restricted database account, no container capabilities | `server/lib/permissions.js`, `server/lib/dbRoles.js` | what each role receives (least privilege); the app account can add audit entries but cannot change or delete them |
| 24-25 | Defence in depth | Built | Independent layers: CSP, validation, RBAC, ownership, encryption, limits, audit | `docs/security/THREAT-MODEL.md`, `server/app.js` | every role against every route (RBAC matrix); name, phone and notes are encrypted at rest |
| 26-27 | Fail-secure defaults | Built | Default-deny routes, refuses to start without secrets, generic errors | `server/config.js`, `server/app.js` | fail-secure when the database is down; if the audit entry fails, the action it describes does not happen; refuses to start without secrets |
| 28-29 | Economy of mechanism | Built | Standard reviewed libraries and one module per responsibility; OpenID Connect sign-in with an organisation account, using a maintained library | `server/lib/crypto.js`, `server/lib/passwords.js`, `server/services/oidc.js` | passwords are stored only as Argon2id hashes; a linked organisation account replaces the password, and the cafe's own code is still required; a callback from another browser, a replayed callback, a wrong nonce or a forged token is refused; one organisation account cannot be linked to two people, and unlinking needs a fresh code |
| 30-31 | Complete mediation | Built | Session and permission checked on every request | `server/middleware/auth.js` | every route has a guard, so none can be left open by accident (complete mediation); disabling a user or changing their role takes effect on the next request |
| 32-33 | Open design | Built | Published algorithms; only keys are secret; audit public keys can be shared | `server/lib/crypto.js`, `server/services/auditLog.js` | detects a recalculated hash, because the attacker cannot sign it |
| 34-35 | Separation of privilege | Built | Second person for large refunds and Admin changes; fresh code for sensitive actions | `server/services/approvals.js` | a large refund waits for a different person with a fresh code; one Admin alone cannot create another Admin; a second Admin must approve |
| 36-37 | Least common mechanism | Built | Separate collections, no shared browser cache, separate per-person limits and sessions; staff and public traffic served by separate app processes | `server/db.js`, `server/app.js`, `deploy/Caddyfile`, `deploy/docker-compose.yml` | each signed-in person has a limit, so one person cannot use up a shared cafe address; the device list shows only your sessions, and you can revoke only your own; staff sessions and public traffic are served by separate app processes |
| 18 (1) | Scenario: denied beyond permission level | Built | Permission checks after authentication | `server/middleware/auth.js` | each role can open only its own pages |
| 18 (2) | Scenario: an extra factor at sign-in | Built | Authenticator code; a security question is also asked with a recovery code, and passkeys can be used | `server/services/mfa.js`, `server/routes/auth.js` | a correct password alone gives no session (MFA is mandatory); a recovery code alone is not enough once a question is set; setting a question needs a fresh code, and the answer is kept only as a hash; the question is shown only after the password step |
| 18 (3) | Scenario: log timestamps altered | Built | Time is part of the signed hash | `server/services/auditLog.js` | detects edited details, a changed actor and a changed time |
| 18 (4) | Scenario: 99.9% uptime guarantee | Out of scope | Depends on the hosting provider | `docs/security/OUT-OF-SCOPE.md` | – |
| 18 (5) | Scenario: encrypted transaction records | Built | Customer details on bills encrypted; amounts stay readable for reports | `server/services/billing.js` | stored encrypted, and masked in every response |
| 19 (6) | Scenario: sensitive email encrypted automatically | Built | Staff notice email is sent only over TLS 1.2 or later with a verified certificate, or not at all, and holds no personal details | `docs/security/OUT-OF-SCOPE.md`, `server/services/mailer.js`, `server/workers.js`, `server/config.js` | a paid bill with a phone queues a receipt holding no phone number; a notice is sent only after the connection switches to TLS, and holds no guest details; a server that cannot encrypt receives nothing, and the message stays queued for a retry; a server whose certificate cannot be verified receives nothing |
| 19 (7), 20 (14) | Scenario: unusual access in logs, all record access reviewed | Built | Address and browser recorded; new networks alert; opening customer records and full-number views logged; a weekly audit log review is recorded, with a reminder when overdue; sign-ins from a new country raise a high alert (local public-domain IP data) | `server/services/auditLog.js`, `server/services/alerts.js`, `server/routes/auth.js`, `server/services/opsChecks.js`, `public/js/audit.js`, `server/lib/geo.js` | only a Manager or Admin can see the full number, and it is logged; one password tried against many usernames from one address raises an alert (password spraying); a new network raises an alert; a known one, and a person's first sign-in, do not; opening one bill is recorded, and many views raise an alert; an overdue review raises a reminder, and recording a review clears it; addresses are placed in countries locally, and private addresses in none; the first country is learned quietly, and a sign-in from a new one raises a high alert |
| 19 (8), (10) | Scenario: code signing and verifying a download's hash | Built | Signed build attestations and SHA-256 checksums on releases, verified on the published v1.0.0; locked packages, pinned images and actions | `.github/workflows/release.yml`, `Dockerfile`, `package-lock.json` | releases carry a signed provenance attestation and checksums; runs on a pinned, minimal base as an unprivileged user; every action is pinned to a commit, and the default token is read-only |
| 19 (9) | Scenario: account lockout | Built | Lock after 3 failures for 15 minutes; Admin can unlock | `server/routes/auth.js` | 3 failures lock the account, and the right password is then refused; an Admin can unlock an account |
| 20 (11) | Scenario: biometric access | Built | Passkeys (WebAuthn): the device's fingerprint, face or PIN check is required to sign in or confirm a sensitive action | `docs/security/OUT-OF-SCOPE.md`, `server/services/passkeys.js`, `server/routes/auth.js`, `public/js/login.js`, `public/js/account.js` | password then passkey signs in; a look-alike site, a skipped fingerprint or PIN check, a replay or someone else's passkey is refused; a passkey without the device's fingerprint or PIN check is refused when added; a passkey can confirm a sensitive action, and removing one needs that confirmation |
| 20 (12) | Scenario: disaster recovery test | Built | Backup, destroy and restore drill in CI | `.github/workflows/ci.yml`, `docs/DEPLOYMENT.md` | CI runs every tool the plan names; a restore brings back every record, and the audit chain still verifies |
| 20 (13) | Scenario: complex passwords | Built | 12+ characters, mixed types, common words refused | `server/lib/passwords.js` | a common word dressed up with capitals, digits and symbols does not pass |
| 20 (15) | Scenario: device list with revoke | Built | Account page lists active sessions, each revocable | `server/routes/auth.js`, `public/js/account.js` | the device list shows only your sessions, and you can revoke only your own |
| 25 | Firewalls and intrusion detection | Out of scope | Handled by the hosting platform; the database network is already private | `docs/security/OUT-OF-SCOPE.md` | – |
| 13 | Cloud-scale DDoS protection | Out of scope | The app adds limits; real flood protection needs a provider such as Cloudflare | `docs/security/OUT-OF-SCOPE.md`, `docs/security/LOAD-TEST.md` | – |

## Week 4

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 5-6 | Stakeholders and business needs | Documented | Stakeholder and asset table | `docs/security/SECURITY-REQUIREMENTS.md` | – |
| 7 | Functional security requirements | Documented | SR-01 to SR-19, each traced to code and tests | `docs/security/SECURITY-REQUIREMENTS.md`, `docs/security/TRACEABILITY.md` | every requirement traces to a threat or regulation, to code that exists and to tests that exist |
| 8 | Non-functional requirements and performance under attack | Built | Staff have their own app process, with limits per address and person. Far better under a flood, but the 10% example is not fully met, as LOAD-TEST.md says | `scripts/load-test.js`, `docs/security/LOAD-TEST.md`, `server/lib/passwords.js`, `deploy/Caddyfile` | one address can send only a limited number of requests; only a few passwords are hashed at once, and an overfull queue is refused; staff sessions and public traffic are served by separate app processes |
| 9 | Regulatory: right to be forgotten | Built | Erase-customer endpoint and 90-day retention | `server/services/customers.js` | erasing removes the person but keeps the bill totals, and needs a fresh code; retention removes personal data after 90 days, and keeps recent data |
| 9 | Regulatory: breach notification within 72 hours | Documented | Breach steps in the runbook, supported by tamper alerts | `docs/security/INCIDENT-RESPONSE.md`, `server/workers.js` | the Admin screen can verify, and a broken chain raises an alert |
| 10 | Use cases and misuse cases | Documented | A misuse case per module, each linked to a test | `docs/security/traceability.json`, `docs/security/TRACEABILITY.md` | every requirement traces to a threat or regulation, to code that exists and to tests that exist |
| 12-13 | Risk-based prioritisation and balance | Documented | Priorities from WSES and RPN; security balanced against a busy shift | `docs/security/SECURITY-REQUIREMENTS.md`, `docs/security/risk-register.json` | – |
| 14-15 | Clear documentation and traceability | Built | Matrix linking requirement, threat, code and test, checked by a script | `scripts/check-traceability.js`, `docs/security/TRACEABILITY.md` | a broken link is caught: a missing test, a missing file and an uncovered threat |
| 16-17 | Continuous review, validation and verification | Documented | Dated review log; tests prove each control | `docs/security/SECURITY-REQUIREMENTS.md`, `docs/security/SCAN-RESULTS.md` | – |
| 20-25 | Assets, attackers, threats, vulnerabilities, mitigations | Documented | Each covered in the threat model | `docs/security/THREAT-MODEL.md` | – |
| 31 | Transaction verification | Built | Signed callback checked against the stored amount, accepted once | `server/services/gateway.js`, `server/services/billing.js` | forged, old, wrong-amount and malformed callbacks are refused; a copied gateway callback is accepted only once |
| 35-41 | The six-step threat modelling process | Documented | One section per step | `docs/security/THREAT-MODEL.md` | – |
| 43, 47-51 | STRIDE | Documented | Six questions for each component; every threat carries a category | `docs/security/THREAT-MODEL.md`, `docs/security/traceability.json` | every STRIDE category has at least one threat, and every threat is met by a requirement |
| 44, 52-70 | PASTA, all seven stages | Documented | Worked for the card payment flow | `docs/security/THREAT-MODEL.md` | – |
| 45, 73-79 | OCTAVE, three phases | Documented | Critical assets, infrastructure weaknesses, strategy | `docs/security/THREAT-MODEL.md` | – |
| 46 | VAST | Documented | A threat diagram per user story | `docs/security/THREAT-MODEL.md` | – |

## Attackers

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 5 | Insider threats | Built | Export limits and alerts, masked data, second person, signed audit trail | `server/routes/business.js`, `server/services/alerts.js` | exports are logged, limited per person, and safe to open in a spreadsheet; a large refund waits for a different person with a fresh code |
| 12 | Insider turning off backups | Built | The backup script records each success; an alert appears after 26 hours without one | `server/services/opsChecks.js`, `scripts/backup.js`, `server/workers.js` | no recent backup raises an alert, and a recent one does not |
| 4 | Cybercriminals, ransomware and card skimming | Built | MFA, no third-party scripts, no card data, encrypted backups | `server/middleware/security.js`, `server/lib/backup.js` | no page uses inline styles or third-party resources (findings 21, 22); approved card payment is paid, with no card details anywhere |
| 7 | Script kiddies | Built | Rate limits, lockout and security headers | `server/app.js`, `server/middleware/security.js` | the auth rate limit stops rapid guessing across accounts; are present on pages and API responses |
| 3 | Hacktivists and defacement | Built | Read-only containers, only listed files served, strict CSP | `deploy/docker-compose.yml`, `server/app.js` | every service is read-only, drops all capabilities and cannot gain privileges; project files cannot be downloaded (finding 15) |
| 8, 15 | Nation-state actors and poisoned updates | Built | Locked packages, pinned images and actions, scanning, signed audit | `package-lock.json`, `.github/dependabot.yml`, `Dockerfile` | every action is pinned to a commit, and the default token is read-only |
| 6 | Cyber terrorists | Out of scope | Very low relevance to a cafe; accepted risk with a reason | `docs/security/OUT-OF-SCOPE.md`, `docs/security/THREAT-MODEL.md`, `docs/security/RESIDUAL-RISKS.md` | – |

## WSES

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 4-5, 12 | WSES formula, parameters and weights | Built | wses() function, with other weights and scales supported | `server/lib/risk.js` | works with other weights and scales, as in the telemedicine exercise (4/5/3/2 and 1/5/8) |
| 16-19 | Worked examples 40, 24 and 8 and ranking | Built | Reproduced exactly | `server/lib/risk.js` | reproduces the slides: login portal 40, order API 24, inventory 8; ranks the slides' components in the same order |
| 3 | Prioritising CafeMS's own components | Built | Risk register on the Admin risk page and CSV | `docs/security/risk-register.json`, `server/services/riskRegister.js`, `public/risk.html` | shows scores worked out by the server, and the export is recorded |

## FMEA

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 5-7 | Severity, occurrence, detection and the scoring guide | Built | rpn() with ratings from 1 to 10 | `server/lib/risk.js` | ratings must be whole numbers from 1 to 10 |
| 8-11 | Worked failures 648, 288 and 72 | Built | Reproduced and ranked | `server/lib/risk.js` | reproduces the slides: 648, 288 and 72, ranked in that order |
| 12-18 | Corrective action, test and recalculation (648 to 54) | Built | Before and after ratings, each linked to the test that proves it | `docs/security/risk-register.json`, `docs/security/RISK-AND-FAILURE-ANALYSIS.md` | recalculates after the corrective action: 648 falls to 54 while severity stays 9; every control it claims is proved by a test that exists |
| 8 | Unauthorized access | Built | Ownership checks, audit and alerts | `server/services/orders.js` | one waiter cannot see or change another waiter's order |
| 9 | Duplicate submissions | Built | Idempotency keys | `server/lib/tx.js` | a double click creates one order and takes stock once |
| 10 | Lost notifications | Built | Outbox with retries and an Admin alert | `server/services/outbox.js` | failures retry with growing gaps, then raise one Admin alert |

## Dependency Matrix

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 2-6 | Matrix codes 2, 1, 1A and 0 | Built | Validated by code | `server/lib/dependencies.js`, `docs/security/dependency-matrix.json` | refuses codes the course does not define, and self-dependencies |
| 7-13 | Worked example ShopMini and its degrees | Built | Reproduced | `server/lib/dependencies.js` | reproduces ShopMini's degrees: AUTH in 2 out 0, ORD in 1 out 3, PAY in 1 out 0 |
| 7 | Soft sync: Pending Payment on timeout | Built | 3-second timeout, then a Pending Payment bill and retry | `server/services/billing.js`, `server/services/gateway.js` | a timeout leaves the bill Pending Payment, the till responsive and revenue unchanged |
| 3 | Soft async: queued messages | Built | Outbox collection and background worker | `server/services/outbox.js`, `server/workers.js` | a delivered message is sent once; stock falling to its reorder level queues one message, without blocking the order |
| 13, 20, 23 | Degrees, graph styles and single points of failure | Built | Report script and an Admin page graph drawn with solid, dashed and dotted edges | `scripts/dependency-report.js`, `public/js/risk.js`, `public/risk.html` | CafeMS's own matrix is valid and names the database as its main single point of failure; each edge carries the slides' line style: solid, dashed or dotted |

## Failures

| Slide | Concept | Status | How CafeMS does it | Where | Proved by |
| --- | --- | --- | --- | --- | --- |
| 6 | Hardware failures | Built | Encrypted backup and tested restore | `server/lib/backup.js` | a restore brings back every record, and the audit chain still verifies |
| 7 | Software bugs and glitches | Built | Automated tests of every control | `package.json` | CI runs every tool the plan names |
| 8 | Configuration errors | Built | Settings validated at start-up | `server/config.js` | refuses weak or wrongly sized keys; uploads cannot be stored inside the web root |
| 9 | Network failures | Built | Timeouts and safe handling of unfinished payments | `server/services/gateway.js` | a gateway crash is treated the same as a timeout |
| 10 | Human errors | Built | Second person, confirmations and an audit trail | `server/services/approvals.js` | the last active Admin cannot be removed, even if a request gets through |
| 11 | Interdependency failures | Built | Hard and soft dependencies, failing closed | `server/lib/dependencies.js` | a failure spreads along hard dependencies: the database takes down the web server, inventory and front end; sign-in fails closed and reveals nothing |
| 13 | Noise that hides real attacks | Built | Repeat alerts are merged; each kind shows five, most serious first, and counts the rest | `server/services/alerts.js` | a flood updates one alert instead of creating many; a flood of low-value alerts cannot push a serious one out of the Admin's list |
| 16-17 | Testing, monitoring, failover and patching | Documented | Each strategy mapped to what CafeMS does; alerts for access, price and security setting changes | `docs/security/RISK-AND-FAILURE-ANALYSIS.md`, `server/services/opsChecks.js` | a role change raises an alert; a changed security setting is recorded by name and raises an alert |
| 17 | User training | Documented | A short guide for staff on passwords, phones, phishing, refunds and reporting problems | `docs/STAFF-SECURITY-GUIDE.md` | – |
| 18-25 | Dependency mapping and failure propagation | Built | Script showing what each component's failure affects | `scripts/dependency-report.js`, `server/lib/dependencies.js` | a soft payment failure leaves orders working; a hard login failure stops them |
