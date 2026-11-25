# CafeMS: a secure website and management system for cafes

CafeMS is a public cafe website with a staff system behind it, built for the **Secure Software Development** course. Customers see the menu and request a table. Staff take orders, run the kitchen, bill tables, manage stock and review reports.

Every rule is enforced on the server. The browser only shows what the server allows.

| | |
| --- | --- |
| **Author** | M. Usman (22L-7991) |
| **Stack** | Node.js 24, Express, MongoDB (local replica set), vanilla JavaScript |
| **Evidence** | 400+ automated tests; coursework concept and traceability records in [docs/security](docs/security/) |
| **Setup** | Local MongoDB, no Docker: see [LOCAL-SETUP.md](docs/LOCAL-SETUP.md) |
| **Roadmap** | [PLAN-FULL-CAFE-MANAGEMENT-SYSTEM.md](docs/PLAN-FULL-CAFE-MANAGEMENT-SYSTEM.md) |

## What it does

| Who | What they can do |
| --- | --- |
| **Customer** | Browse the live menu, order takeaway or delivery online or from a QR code on their table, follow the order on a private tracking page, book a table at a time that is still free, rate their visit |
| **Waiter** | Take dine-in, takeaway and delivery orders on the POS (with item options), hold and send them, move them between tables, serve, request the bill, manage reservations and the walk-in waitlist on a real floor plan, enrol loyalty members |
| **Barista** | Bar display: makes the drinks part of each order |
| **Kitchen** | Kitchen display: moves the food part of each order from Placed to Preparing to Ready, and logs waste; never sees prices or customer data |
| **Cashier** | Take counter (takeaway and delivery) orders; bill tables and counter orders with cash, card or wallet, split bills and mixed payments, tips, loyalty points and vouchers, and discounts up to the limit set in Settings; open and close a shift with a cash drawer count and Z-report |
| **Manager** | Billing with a higher discount limit; voids and refunds after a fresh authenticator code; every shift's Z-report; stock with suppliers, purchase orders (bought in packs, received with cost), stocktakes and the waste log; loyalty members, vouchers and guest feedback; reports, reservations |
| **Admin** | Menu, photos and item options, with each dish's ingredient cost and margin; staff and roles; settings (cafe details, tax, discount limits, receipt, tables, categories and their station, order types); audit log, security alerts |

Guest orders from the website or a table's QR code wait in an incoming queue until staff accept them (they go to the kitchen) or decline them (stock is returned and the guest sees why).

The service loop: a waiter sends an order, stock is taken, the kitchen prepares it, the waiter serves it and asks for the bill, the cashier takes payment, and it all appears in the reports and the audit log.

## How it is secured

| Area | Control |
| --- | --- |
| Sign-in | Argon2id passwords; authenticator codes required for Admins and Managers; a hashed, lockable PIN to switch user on shared tablets; lockout after 3 failures, rate limits |
| Sessions | Signed `__Host-` HttpOnly, SameSite=Strict cookie with a revocable server record; 5-minute idle and 8-hour limits |
| Access | One permission table on every route; waiters reach only their own orders and cashiers only today's bills; a second person for large refunds and Admin changes |
| Input | Strict schemas that refuse unknown fields; totals worked out on the server |
| Browser | Strict CSP with Trusted Types, no inline code, no third-party resources, CSRF token and Origin check |
| Data | AES-256-GCM for customer details, masked numbers, 90-day retention, erasure on request, encrypted backups |
| Accountability | Hash-chained audit log signed with Ed25519, written in the same transaction as each action; alerts |
| Database | Local MongoDB replica set with login required; the app uses its own least-privilege login and cannot change or delete audit entries |
| Pipeline | ESLint, Semgrep, CodeQL, gitleaks, dependency audit and tests on every push |

## Security documents

| Document | Contents |
| --- | --- |
| [CONCEPT-COVERAGE.md](docs/security/CONCEPT-COVERAGE.md) | Every lecture concept, with the file and test that prove it |
| [SECURITY-REQUIREMENTS.md](docs/security/SECURITY-REQUIREMENTS.md) | Functional, non-functional and regulatory requirements; review log |
| [TRACEABILITY.md](docs/security/TRACEABILITY.md) | Requirement to threat to code to test; misuse cases |
| [THREAT-MODEL.md](docs/security/THREAT-MODEL.md) | Six-step process, attackers, STRIDE, PASTA, OCTAVE and VAST |
| [RISK-AND-FAILURE-ANALYSIS.md](docs/security/RISK-AND-FAILURE-ANALYSIS.md) | WSES, FMEA, dependency matrix and failure types |
| [SCAN-RESULTS.md](docs/security/SCAN-RESULTS.md) | What each scanner found, and every accepted exception |
| [LOAD-TEST.md](docs/security/LOAD-TEST.md) | Staff response times during a simulated flood |
| [INCIDENT-RESPONSE.md](docs/security/INCIDENT-RESPONSE.md) | Runbook, playbooks, key rotation and the 72-hour breach steps |
| [RESIDUAL-RISKS.md](docs/security/RESIDUAL-RISKS.md) | What remains, and why |
| [OUT-OF-SCOPE.md](docs/security/OUT-OF-SCOPE.md) | What cannot be built inside a web app |
| [BURP-TEST-SCRIPT.md](docs/security/BURP-TEST-SCRIPT.md) | The manual penetration test |

Screens update live over Server-Sent Events: the stream carries only the names of changed areas, and each screen re-reads its own role-filtered data. The payment gateway and SMS or email delivery are simulated, because real ones need provider accounts.

## Run it locally

You need Node.js 24 and a local MongoDB server running as a replica set (one-time steps in [LOCAL-SETUP.md](docs/LOCAL-SETUP.md)). No Docker is needed.

```bash
npm install
```

```bash
npm run setup
```

```bash
npm start
```

Open http://localhost:3000.

`npm run setup` does four things:
- creates the keys and database passwords in `.env`, which git ignores;
- checks MongoDB;
- creates the app's database login and indexes;
- on an empty database, adds a demo cafe.

The demo cafe includes a starting photo for each menu item (free-licence photos, credited in [scripts/seed-photos/CREDITS.md](scripts/seed-photos/CREDITS.md)). Staff accounts get random passwords, saved to `.seed-credentials.txt`. There are no default passwords. Admins and Managers add an authenticator app at first sign-in; other staff can set a tablet PIN on their account page. The server refuses to start if a key is missing or weak.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | One-command setup against the local MongoDB (safe to run again) |
| `npm test` | All tests, using a temporary in-memory database (never your data) |
| `npm run test:coverage` | Tests with coverage thresholds |
| `npm run lint` | ESLint with security rules |
| `npm run deps:report` | Dependency matrix report and single points of failure |
| `npm run load-test` | Staff response times during a simulated flood |
| `npm run backup` and `npm run restore` | Encrypted backup, and restore into an empty database |

## Project layout

```
server/        Express app, routes, services, security middleware
public/        Pages, browser scripts, styles and self-hosted fonts
scripts/       Setup, seed, backup, first Admin, load test and report tools
tests/         Automated tests, including attack and failure tests
docs/          Local setup guide, roadmap, coursework and security documents
.github/       CI, release checksums, Dependabot and the pull request checklist
```

Earlier coursework is in [SUBMISSION.md](SUBMISSION.md), [SUBMISSION-ACTIVITY2.md](SUBMISSION-ACTIVITY2.md), [SUBMISSION-ACTIVITY3.md](SUBMISSION-ACTIVITY3.md) and [SUBMISSION-ACTIVITY4.md](SUBMISSION-ACTIVITY4.md). They describe the prototype as it stood at each activity.

Activity 6 (backend, JWT and authorization) is in [SUBMISSION-ACTIVITY6.md](SUBMISSION-ACTIVITY6.md). Its evidence is in [docs/activity-6](docs/activity-6/), regenerated by `node scripts/activity6-evidence.js`.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
