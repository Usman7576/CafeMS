# Code review log

**Four reviews have been carried out, and every finding is recorded here with its outcome.** This is a single-author project, so no second human has reviewed the code. The independent review below was done by an automated reviewer working from the code and lecture decks alone, without the project's plan. It does not replace review by a person, and future changes should use the checklist in `.github/pull_request_template.md`.

| Date | Review | Reviewer | Result |
| --- | --- | --- | --- |
| 2026-11-09 | Code compared again with every slide of the eight decks | Automated reviewer, with proof tests | 1 proven weakness, 7 partial concepts, 3 documentation errors; outcomes below |
| 2026-11-09 | Whole system against the eight lecture decks | Independent automated reviewer | 18 defects, 8 thin concepts and 17 inaccurate claims; outcomes below |
| 2026-11-09 | CodeQL findings from the first CI run | CodeQL, checked by hand | 5 fixed, 1 false positive dismissed with a reason |
| 2026-11-04 | Phases 1 to 4 against the plan | Author, with tests on a throwaway database | 16 problems, all fixed; listed in the plan's log |

## Second comparison with the decks, 9 November 2026

| Deck | Finding | Outcome | Proved by |
| --- | --- | --- | --- |
| Failures, slide 13 | A flood of alerts could push a serious one out of the Admin's list | Fixed: each kind shows at most five, most serious first, and says how many more it holds | "a flood of low-value alerts cannot push a serious one out of the Admin's list" |
| Failures, slide 16 | No alert when access, prices or security settings changed | Fixed | "a role change raises an alert", "a changed security setting is recorded by name and raises an alert" |
| Attackers, slide 12 | Nothing noticed if backups stopped | Fixed: alert after 26 hours | "no recent backup raises an alert, and a recent one does not" |
| Week 2, scenario 7 | A successful sign-in from a new place raised nothing | Fixed for networks; there is no country lookup | "a new network raises an alert; a known one, and a person's first sign-in, do not" |
| Week 2 scenario 14, FMEA slide 15 | Opening customer records was not logged | Fixed: once an hour per person and view, with an alert for many | "opening one bill is recorded, and many views raise an alert" |
| SSD Lec1, slides 3 and 8 | Uploads were checked only by their first bytes | Fixed: decoded and rewritten, removing hidden content and metadata | "content hidden after a real image, and its metadata, do not survive" |
| Week 4, slide 8 | Far more than 10% slower under a flood | Greatly reduced, not fully met: staff now have their own app process, cutting the slowdown from about 1,300% to between roughly 0% and 80%, depending on what else the machine is doing. Capping password hashing gave no speed gain and remains only to limit memory use | "only a few passwords are hashed at once, and an overfull queue is refused" |
| Week 4, slide 14 | Not all data at rest was encrypted | Fixed: production uses Percona Server for MongoDB with AES-256-GCM on every database file | "every database file is encrypted at rest with AES-256, and the key stays out of git and the image" |
| Week 4 slide 24, Failures slide 17 | The MFA library was deprecated and others were behind | Fixed: `otplib` 13, Express 5, MongoDB driver 7 and others upgraded | Whole test suite |
| Week 2, scenario 14 | No routine for reading the audit log | Fixed: weekly review recorded from the Audit page, with a reminder when overdue | "an overdue review raises a reminder, and recording a review clears it" |

## Independent review of 9 November 2026

The reviewer was told to treat this project's documents as claims and to prove findings where possible. Each proof was then rerun before anything was changed.

### Defects

| # | Severity | Finding | Outcome | Proved by |
| --- | --- | --- | --- | --- |
| 1 | High | The second-Admin rule made adding a second Admin, or disabling a stolen one, impossible | Fixed: `create-admin` creates up to two Admins; one Admin can disable another at once with an alert; the server's operator can recover an Admin | "one Admin can disable a compromised Admin at once, and it raises an alert" |
| 2 | Medium | Rows added outside the audit chain were shown as genuine and passed verification | Fixed: verification fails, such rows are hidden, and the database refuses them | "a row added outside the chain fails verification and is never shown" |
| 3 | Medium | The app's database account could erase the audit log with a TTL index | Fixed: only the administrator can create audit indexes | "the app's database account cannot add indexes to the audit log, so it cannot erase it with a TTL index" |
| 4 | Medium | Backups taken during activity were inconsistent | Fixed: one point-in-time snapshot; a restore now checks the chain | "a backup taken while the cafe is busy restores with a valid audit chain" |
| 5 | Medium | Verifying during activity raised false tamper alarms | Fixed: only entries up to the head read first are checked | "verifying while actions are being written gives no false alarm" |
| 6 | Medium | One Admin could satisfy the second-person refund rule with an account they made | Fixed: whoever set up an account cannot approve that person's refund | "the Admin who set up a Manager's account cannot approve that Manager's large refund" |
| 7 | Medium | Waiters could confirm guessed numbers by searching, unrecorded and unlimited | Fixed: limited to 30 an hour, recorded and alerted | "searching by number is limited per person and recorded, without storing the number" |
| 8 | Medium | Anyone knowing a username can lock that account | Accepted and recorded: the course requires lockout. Another Admin can unlock, and the operator can recover an Admin | "an Admin can unlock an account" |
| 9 | Low | Step-up codes and password changes ignored the account lock | Fixed | "a locked account cannot pass an authenticator re-check or change its password" |
| 10 | Low | Passwords typed as a username were stored in the audit log | Fixed: only a keyed reference is kept | "an unknown username is never stored, in case a password was typed there" |
| 11 | Low | An unsupported charset caused a 500 error | Fixed: 415 | "an unsupported charset is a client error, not a server error" |
| 12 | Low | The export limit was per route | Fixed: per person across all exports | "the export limit is shared by every export, per person" |
| 13 | Low | Refunds had no age limit or gateway reversal | Fixed: 30-day window, one reversal per bill, alert on failure | "a card refund reaches the gateway once; a cash refund does not" |
| 14 | Low | Many recent bookings could hide upcoming ones | Fixed: fetched separately | "upcoming bookings stay listed however many recent ones exist" |
| 15 | Low | A declined bill advised another payment method with no way to choose one | Fixed: Take cash button | "a declined bill offers cash, and the risk page draws the graph" |
| 16 | Low | A callback that failed part-way could not be retried | Fixed: the replay record commits with the result | "a callback that failed part-way can be retried; only a processed one is a replay" |
| 17 | Low | Cloudflare advice lacked proxy settings | Fixed in `docs/DEPLOYMENT.md`; `TRUST_PROXY` is now configurable | Documented |
| 18 | Low | New menu items had no way to get a recipe | Fixed: recipe editor | "an Admin can give an item a recipe, and an order then takes that stock" |

### Concepts the reviewer found missing or thin

| Concept | Outcome |
| --- | --- |
| Burp Suite | Still open: it needs a person to run [BURP-TEST-SCRIPT.md](BURP-TEST-SCRIPT.md) |
| Redundancy and failover | Added a three-member database option and a CI drill that kills the primary |
| Dependency graph with edge styles | Added to the Admin risk page and the report script |
| Code signing | Added signed build attestations to releases |
| DAST | Added an active, signed-in ZAP scan of the API |
| Code review | This log; it remains limited by having one author |
| User training | Added `docs/STAFF-SECURITY-GUIDE.md` |
| Non-repudiation | The server signs entries, not each person; recorded in [RESIDUAL-RISKS.md](RESIDUAL-RISKS.md) |

The 17 inaccurate or overstated statements in the documents and comments have been corrected.
