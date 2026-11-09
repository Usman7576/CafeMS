# Risk and failure analysis

**Sign-in and billing remain the most exposed parts of CafeMS, and the database is its main single point of failure.** Every failure mode from the prototype audit now scores far lower: the worst, login accepting any password, fell from an RPN of 900 to 40.

The scores below are worked out by code, not typed in. `server/lib/risk.js` holds the WSES and RPN formulas, and `server/lib/dependencies.js` analyses the dependency matrix. Tests reproduce every worked example in the slides: WSES 40, 24 and 8; RPN 648, 288, 72 and 54; ShopMini's degrees. The same numbers are on the Admin risk page and in its CSV export. The data lives in `risk-register.json` and `dependency-matrix.json` in this folder.

## Weighted Security Exposure Score

WSES rates a component's exposure:

```latex
\text{WSES} = 2 \cdot \text{Accessibility} + 3 \cdot \text{Data sensitivity} + 2 \cdot \text{Past incidents} + 1 \cdot \text{Complexity}
```

Each parameter scores Low 1, Medium 3 or High 5, so scores run from 8 to 40. Past incidents count defects found in our own audits, because the cafe has no production history.

| Rank | Component | Before | Now | Ratings now (access, data, incidents, complexity) |
| --- | --- | --- | --- | --- |
| 1 | Sign-in, MFA and sessions | 38 | 36 | High, High, Medium, High |
| 2 | Billing, payments and refunds | 36 | 32 | Medium, High, Medium, High |
| 3 | Audit log | 34 | 26 | Low, High, Medium, Medium |
| 4 | MongoDB database | 34 | 26 | Low, High, Medium, Medium |
| 5 | Reservations | 24 | 24 | Medium, Medium, Medium, Medium |
| 6 | Public website and online booking | 16 | 24 | High, Medium, Low, Medium |
| 7 | Staff accounts and roles | 34 | 22 | Low, High, Low, Medium |
| 8 | Orders and kitchen | 24 | 14 | Medium, Low, Low, Medium |
| 9 | Inventory | 12 | 8 | Low, Low, Low, Low |
| – | Whole-database API (/api/state) | 36 | Removed | Route deleted |

WSES measures exposure, not the quality of the controls, so it falls only where access, data, incidents or complexity really changed. Sign-in stays near the top because it must face the internet and holds secrets; that is why it has the most controls. The public website went up, from 16 to 24, because online booking now collects a name and number.

## FMEA: failure modes and their Risk Priority Numbers

```latex
\text{RPN} = \text{Severity} \times \text{Occurrence} \times \text{Detection}
```

Each rating runs from 1 to 10, using the scoring guide in the FMEA deck.

| ID | Failure mode | Before (S × O × D) | Now (S × O × D) | Corrective action |
| --- | --- | --- | --- | --- |
| FM-1 | Login accepts any password | 900 (10 × 10 × 9) | 40 (10 × 2 × 2) | Argon2id check on the server, mandatory MFA, failed sign-ins recorded and alerted |
| FM-2 | Database read or replaced without signing in | 810 (10 × 9 × 9) | 30 (10 × 1 × 3) | Whole-database routes removed; every route guarded and checked by a test |
| FM-3 | Role or ownership check bypassed | 648 (9 × 8 × 9) | 54 (9 × 2 × 3) | Server permission matrix on every route, ownership in every query, denials audited and alerted |
| FM-4 | Bill total or quantity tampered with | 576 (9 × 8 × 8) | 27 (9 × 1 × 3) | Totals worked out on the server from stored prices; strict schemas refuse extra fields |
| FM-5 | Two screens save at once and one change is lost | 448 (7 × 8 × 8) | 28 (7 × 2 × 2) | Transactions, version checks and atomic stock updates |
| FM-6 | Audit log edited without anyone noticing | 360 (8 × 5 × 9) | 32 (8 × 2 × 2) | Signed SHA-256 chain, verified every 15 minutes with an alert; app account cannot edit entries |
| FM-7 | Payment gateway or notification lost | 288 (6 × 6 × 8) | 36 (6 × 3 × 2) | 3-second gateway timeout to Pending Payment with retry; notification outbox with retries and an Admin alert |
| FM-9 | Authenticator codes guessed without a lockout | 288 (9 × 4 × 8) | 27 (9 × 1 × 3) | Failure count clears only after the full sign-in; alert on many failures from one address |
| FM-11 | An action is saved without its audit entry | 216 (8 × 3 × 9) | 24 (8 × 1 × 3) | Every change commits in the same transaction as its entry |
| FM-10 | Customer charged twice | 168 (7 × 3 × 8) | 14 (7 × 1 × 2) | No second payment during a charge; a late approval is recorded and alerted |
| FM-8 | Double click creates a duplicate order | 112 (4 × 7 × 4) | 8 (4 × 1 × 2) | Idempotency key on every order, payment and refund |

FM-9 to FM-11 were found in the review of Phases 1 to 4; their "before" ratings describe the code at that review.

### The FMEA process, applied to FM-3

The FMEA deck's steps after calculating the RPN, applied to the role and ownership failure:

1. **Start with the highest-priority failure.** FM-3 scored 648 (S 9, O 8, D 9): the prototype checked roles only in the browser, so anyone could skip them.
2. **Decide the corrective action.** Check every request's role on the server against one permission table. Put ownership into every query, so another waiter's order looks the same as one that does not exist. Record each denial in the audit log, and alert on repeated denials.
3. **Test the improvement.** Tests confirm that a waiter can open their own order but not another's, and that every role is checked against every route. They also confirm that each denial is recorded and that repeated denials raise an alert.
4. **Recalculate the RPN.** Severity stays 9, because exposing another person's data would still be serious. Occurrence falls to 2 and detection difficulty to 3, giving an RPN of 54, the same result as the deck's worked example.

The tests behind every failure mode are listed in `risk-register.json`. A test fails if any of them is renamed or removed.

## Dependency matrix and failure propagation

Rows call columns: 2 is hard sync, 1 soft sync, 1A soft async and 0 none. PAY and NOTIFY are external.

| Caller \ Callee | APP | API | AUTH | AUDIT | DB | PAY | QUEUE | NOTIFY |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **APP** | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 |
| **API** | 0 | 0 | 2 | 2 | 2 | 1 | 1A | 0 |
| **AUTH** | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| **AUDIT** | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| **DB** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **PAY** | 0 | 1A | 0 | 0 | 0 | 0 | 0 | 0 |
| **QUEUE** | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 1 |
| **NOTIFY** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Why the less obvious cells are what they are:
- **API to PAY is 1 (soft sync).** The charge is tried for up to 3 seconds. On a timeout the bill is saved as Pending Payment, and the cashier carries on.
- **API to QUEUE is 1A (soft async).** Receipts and staff notices go into the outbox in the same transaction and are sent later.
- **API to AUDIT is 2 (hard sync).** An action that cannot be recorded does not happen. This is the fail-secure rule, chosen deliberately even though it makes the audit log a single point of failure.
- **PAY to API is 1A.** The gateway's signed callback confirms a payment later, and the till does not wait for it.

`npm run deps:report` prints the degrees and what each failure does:

| Component fails | Stops | Carries on degraded | Delayed |
| --- | --- | --- | --- |
| DB | API, AUTH, AUDIT, QUEUE, APP | – | PAY callbacks |
| AUDIT | API, AUTH, APP | – | PAY callbacks |
| AUTH | APP, API | – | PAY callbacks |
| API | APP | – | PAY callbacks |
| PAY (external) | – | API (bills wait as Pending Payment) | – |
| QUEUE | – | – | API's messages |
| NOTIFY (external) | – | QUEUE (retries, then an Admin alert) | – |

**Single points of failure, and what reduces each one:**
- **DB**, with 4 hard callers, stops 5 services. It has encrypted backups with a tested restore. It runs as a replica set with one member, so it cannot fail over: surviving a server failure needs three members or a managed database, as `docs/DEPLOYMENT.md` explains.
- **AUDIT** stops 3. This is accepted, because the fail-secure rule outweighs availability here. It shares the database's replica set, so in practice it fails only when the database does.
- **AUTH** stops 2. It has no outside dependency, and its sessions are stored in the database.

## The six failure types

As the Failures deck notes, a failure is not always an attack, but an attacker can exploit one.

| Failure type | Example in CafeMS | Control | Proved by |
| --- | --- | --- | --- |
| Hardware | The database disk fails | Encrypted, checksummed backups with a tested restore; a multi-member replica set in production | "a restore brings back every record, and the audit chain still verifies" |
| Software bug | A bug lets a waiter edit another waiter's order | Ownership in every query; 300+ automated tests | "one waiter cannot see or change another waiter's order" |
| Configuration error | Server started with a weak key or no database login | Settings checked at start-up; the server refuses to run | "refuses weak or wrongly sized keys" |
| Network | The payment gateway stops answering | 3-second timeout, then Pending Payment and retry | "a timeout leaves the bill Pending Payment, the till responsive and revenue unchanged" |
| Human error | A manager refunds the wrong bill, or an Admin gives too much access | Second person over Rs 5,000; second Admin for Admin changes; audit log | "a large refund waits for a different person with a fresh code" |
| Interdependency | The database fails and every service that needs it stops | Dependency matrix, replica set, soft dependencies on outside services | "sign-in fails closed and reveals nothing" |

## Mitigation strategies from the Failures deck

| Strategy | How CafeMS applies it |
| --- | --- |
| Regular testing and maintenance | `npm test` runs every control; CI runs it on every push and weekly |
| Automated monitoring and alerts | Alert rules on the audit log every minute; audit chain verified every 15 minutes |
| Noise that hides attacks | Repeats update one open alert instead of creating new ones, so a flood of minor events cannot bury a real attack |
| Redundancy and failover | Soft dependencies on the gateway and message provider; a three-member replica set or managed database is the owner's choice at deployment |
| Training and access control | Least-privilege roles, masked data and the role notes on each screen |
| Consistent patching | `npm audit` and Trivy run in CI; Dependabot proposes updates weekly; base images are pinned by digest |
