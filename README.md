# CafeMS: a secure website and management system for cafes

CafeMS is a public cafe website with a staff system behind it, built for the **Secure Software Development** course. Customers see the menu and request a table. Staff take orders, run the kitchen, bill tables, manage stock and review reports.

Every rule is enforced on the server. The browser only shows what the server allows.

| | |
| --- | --- |
| **Author** | M. Usman (22L-7991) |
| **Stack** | Node.js 24, Express, MongoDB replica set, vanilla JavaScript, three.js, Docker, Caddy |
| **Evidence** | 330+ automated tests, all lecture concepts mapped in [CONCEPT-COVERAGE.md](docs/security/CONCEPT-COVERAGE.md) |
| **Deployment** | Runs on any Linux server with Docker: see [DEPLOYMENT.md](docs/DEPLOYMENT.md). Netlify cannot host it |

## What it does

| Who | What they can do |
| --- | --- |
| **Customer** | Browse the live menu, see opening hours, request a table online |
| **Waiter** | Take and edit their own orders, serve, request the bill, manage reservations |
| **Kitchen** | Move tickets from Placed to Preparing to Ready; never sees prices or customer data |
| **Cashier** | Bill tables with cash, card or wallet, and discounts up to 10% |
| **Manager** | Everything a cashier does, with discounts to 25%; refunds, stock, reports, reservations |
| **Admin** | Menu and photos, staff and roles, cafe details, audit log, security alerts, risk register |

The service loop: a waiter sends an order, stock is taken, the kitchen prepares it, the waiter serves it and asks for the bill, the cashier takes payment, and it all appears in the reports and the audit log.

## How it is secured

| Area | Control |
| --- | --- |
| Sign-in | Argon2id passwords, authenticator codes for all staff, lockout after 3 failures, rate limits |
| Sessions | Signed `__Host-` HttpOnly, SameSite=Strict cookie with a revocable server record; 5-minute idle and 8-hour limits |
| Access | One permission table on every route, ownership in every query, a second person for large refunds and Admin changes |
| Input | Strict schemas that refuse unknown fields; totals worked out on the server |
| Browser | Strict CSP with Trusted Types, no inline code, no third-party resources, CSRF token and Origin check |
| Data | AES-256-GCM for customer details, masked numbers, 90-day retention, erasure on request, encrypted backups |
| Accountability | Hash-chained audit log signed with Ed25519, written in the same transaction as each action; alerts |
| Delivery | Non-root, read-only distroless container; HTTPS through Caddy; private database network with a least-privilege login |
| Pipeline | ESLint, Semgrep, CodeQL, gitleaks, Trivy, OWASP ZAP, a restore drill and tests on every push |

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

Admins can also see risk scores on the Risk register page. The payment gateway and SMS or email delivery are simulated, because real ones need provider accounts.

## Run it locally

You need Node.js 24 and Docker Desktop. MongoDB runs as a replica set in Docker, because payments and orders use transactions.

```bash
npm install
```

```bash
npm run setup:env
```

```bash
docker compose up -d --wait
```

```bash
npm run db:setup
```

```bash
npm run seed:dev
```

```bash
npm start
```

Open http://localhost:3000. `setup:env` creates the keys and database passwords in `.env`, which git ignores. The server refuses to start if a key is missing or weak. `seed:dev` creates staff accounts with random passwords, shown once. There are no default passwords, and each person adds an authenticator app at first sign-in.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | All tests, using a temporary database |
| `npm run test:coverage` | Tests with coverage thresholds |
| `npm run lint` | ESLint with security rules |
| `npm run trace` | Checks and regenerates the traceability matrix |
| `npm run concepts` | Checks and regenerates the concept coverage |
| `npm run deps:report` | Dependency matrix report and single points of failure |
| `npm run load-test` | Staff response times during a simulated flood |
| `npm run backup` and `npm run restore` | Encrypted backup, and restore into an empty database |

## Project layout

```
server/        Express app, routes, services, security middleware
public/        Pages, browser scripts, styles, self-hosted fonts and three.js
scripts/       Setup, seed, backup, first Admin, load test and report tools
tests/         Automated tests, including attack and failure tests
deploy/        Production Compose stack and Caddy configuration
docs/          Deployment guide and security documents
.github/       CI, release checksums, Dependabot and the pull request checklist
```

Earlier coursework is in [SUBMISSION.md](SUBMISSION.md), [SUBMISSION-ACTIVITY2.md](SUBMISSION-ACTIVITY2.md) and [SUBMISSION-ACTIVITY3.md](SUBMISSION-ACTIVITY3.md). They describe the prototype as it stood at each activity.

To report a vulnerability, see [SECURITY.md](SECURITY.md).
