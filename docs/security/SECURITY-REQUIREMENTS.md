# Security requirements

CafeMS has 28 security requirements: 19 functional, 5 non-functional and 4 regulatory. Each one is written to be testable, traces to a threat or a regulation, and is proved by at least one automated test. The full links are in [TRACEABILITY.md](TRACEABILITY.md), which `npm run trace` checks and regenerates.

This document follows the Week 4 process: define requirements early, involve stakeholders, cover all three types, use use and misuse cases, prioritise by risk, document clearly with traceability, and keep reviewing.

## Stakeholders and what they need protected

| Stakeholder | Cares about | Assets |
| --- | --- | --- |
| Cafe owner | Revenue, reputation, legal compliance | Bills, refunds, prices, the audit log |
| Customers | Privacy of their name and number | Reservations, receipt numbers |
| Staff (waiter, kitchen, cashier, manager) | A fast, reliable till during a rush | Their accounts, orders, the kitchen queue |
| Admin | Control over who can do what | Staff accounts, roles, menu, settings |
| Payment provider | Correct, signed payment results | Gateway callbacks, the shared signing key |

## Requirement types

**Functional** requirements say what security behaviour the system provides, for example "The system shall require a TOTP authenticator code for every staff sign-in" (SR-01).

**Non-functional** requirements describe qualities under pressure: availability under a request flood (SR-20), resilience when the payment gateway is down (SR-21), recoverability (SR-22), usability during a busy shift (SR-23) and a hardened deployment (SR-28).

**Regulatory** requirements come from law and industry standards: the right to erasure (SR-24), storage limitation (SR-25), keeping card data out of scope (SR-26) and breach notification within 72 hours (SR-27).

| ID | Type | Priority | Requirement |
| --- | --- | --- | --- |
| SR-01 | Functional | High | TOTP authenticator code for every staff sign-in, with single-use recovery codes |
| SR-02 | Functional | High | Argon2id password hashes; 12+ characters, mixed types, no common base words |
| SR-03 | Functional | High | 15-minute lock after 3 failed passwords or codes, counted on the server |
| SR-04 | Functional | High | Signed HttpOnly `__Host-` cookie with a server record; 5-minute idle and 8-hour limits |
| SR-05 | Functional | High | One permission table checked on every route; anything unlisted is denied |
| SR-06 | Functional | High | Waiters see only their own orders; cashiers only today's bills |
| SR-07 | Functional | High | Prices and totals worked out on the server; strict input schemas |
| SR-08 | Functional | High | CSRF token and same-origin check on every change |
| SR-09 | Functional | High | Strict CSP with Trusted Types; no HTML built from strings |
| SR-10 | Functional | High | Second person for refunds over Rs 5,000 and Admin changes; fresh code for sensitive actions |
| SR-11 | Functional | High | Signed, hash-chained audit log written in the same transaction as the action |
| SR-12 | Functional | High | All database files and customer fields encrypted with AES-256-GCM, masked by role; opening records and full views logged |
| SR-13 | Functional | Medium | Photo uploads checked by signature, 2 MB limit, stored outside the web root |
| SR-14 | Functional | High | Idempotency keys, transactions and version checks |
| SR-15 | Functional | High | Signed, single-use gateway callbacks; no second payment during a charge |
| SR-16 | Functional | Medium | De-duplicated alerts, which a flood cannot hide, for sign-in failures, new networks, denials, exports, record and number views, refunds, payment conflicts, access and price changes, security settings and stopped backups |
| SR-17 | Functional | High | Least-privilege database account; production needs database credentials |
| SR-18 | Functional | High | Refuse to start with weak secrets; generic error messages |
| SR-19 | Functional | Medium | Exports limited per person, recorded and safe in spreadsheets |
| SR-20 | Non-functional | High | Keeps serving under a flood: staff have their own process; limits per address, per person and for pages |
| SR-21 | Non-functional | Medium | A slow gateway or message provider never stops the till |
| SR-22 | Non-functional | Medium | Encrypted backups with tested restore; graceful shutdown |
| SR-23 | Non-functional | Low | Active staff stay signed in; automatic refreshes never keep an idle session open |
| SR-24 | Regulatory | High | Erase a customer's data on request, keeping tax totals |
| SR-25 | Regulatory | Medium | 90-day retention, data minimisation and a privacy notice |
| SR-26 | Regulatory | High | No card or wallet details ever received or stored |
| SR-27 | Regulatory | Medium | Breaches detectable and reportable within 72 hours; no secrets in logs |
| SR-28 | Non-functional | High | Production runs over HTTPS as an unprivileged, read-only container; only the proxy is reachable from outside |
| SR-35 | Non-functional | High | Web application firewall (OWASP Core Rule Set) and edge rate limits in front of the app |
| SR-30 | Functional | High | Passkeys with the device's fingerprint, face or PIN, usable only on this site |
| SR-31 | Functional | High | A security question as well as a recovery code |
| SR-32 | Functional | High | High alert for a sign-in from a new country |
| SR-33 | Functional | High | Email only over verified TLS, with no personal details |
| SR-34 | Functional | High | OpenID Connect sign-in with PKCE, state, nonce and signature checks; own second factor still required |
| SR-29 | Functional | High | Refunds, approvals, staff changes and erasure signed by the person's own device key, kept and re-checkable (non-repudiation) |

## Use and misuse cases

Each module has a normal use case and a misuse case describing how the system responds to abuse. All 12 are linked to tests in [TRACEABILITY.md](TRACEABILITY.md#use-and-misuse-cases). Two examples:

- **Sign-in (MC-01).** A waiter signs in with a password and an authenticator code. Misuse: an attacker with a leaked password keeps trying codes. Response: three wrong codes lock the account for 15 minutes, and the failures raise an alert.
- **Refunds (MC-04).** A manager refunds a wrong item. Misuse: a manager refunds a large bill to an accomplice. Response: over Rs 5,000 a different person must approve with a fresh code, and a spike in refunds raises an alert.

## How they were prioritised

Priority follows risk, as Week 4 recommends: likelihood times impact. The risk register supplies both numbers.

- **Components** are ranked by the Weighted Security Exposure Score. Sign-in scored 38 out of 40 and billing 36, so their requirements (SR-01 to SR-04, SR-07, SR-10, SR-15) are High.
- **Failure modes** are ranked by FMEA's Risk Priority Number. Login accepting any password scored 900 and an unprotected database 810, so those were fixed first, in Phase 1.

Security is balanced against a busy shift. For example, SR-23 keeps active staff signed in, and the lock lasts 15 minutes rather than needing an Admin. The Admin risk page and [RISK-AND-FAILURE-ANALYSIS.md](RISK-AND-FAILURE-ANALYSIS.md) show the scores.

## Review and verification

Requirements are reviewed whenever the design changes, and each review is dated:

| Date | Review | Outcome |
| --- | --- | --- |
| 2026-11-09 | Second check of the code against all eight decks ([CODE-REVIEW.md](CODE-REVIEW.md)) | 1 proven weakness and 7 partial concepts addressed; the flood target greatly improved but not fully met |
| 2026-11-09 | Independent review of the finished system ([CODE-REVIEW.md](CODE-REVIEW.md)) | 18 defects and 8 thin concepts; all addressed, each code defect with a test |
| 2026-11-09 | Phase 7: every role's screens walked through in a browser, on desktop and phone width | Two defects fixed: refreshes redrew screens needlessly and took focus from the cash box; wide tables made phone pages too wide |
| 2026-11-09 | Phase 6: scanners, deployment and load test | SR-28 added; findings fixed and recorded in SCAN-RESULTS.md |
| 2026-11-07 | Phase 5: requirements written down with traceability | 27 requirements, all linked to code and tests |
| 2026-11-06 | Fixes from the Phase 1 to 4 review | 16 findings fixed, each with a test |
| 2026-11-04 | Review of Phases 1 to 4 against the plan | 16 problems found by testing |
| 2026-11-04 | Original audit of the prototype | 33 findings; the basis for SR-01 to SR-19 |

Verification is automated: every requirement names tests, `npm test` runs them, and `npm run trace -- --check` fails if a requirement loses its code or its tests.
