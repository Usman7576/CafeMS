# Security scan results

**On 9 November 2026 every scan of CafeMS's own code and image passed, after fixing what they found.** The only open findings are in the official Caddy and Percona MongoDB images, where the publishers have not yet released fixes. CI repeats these scans on every push and weekly. CodeQL runs only on GitHub: it has 0 open alerts, after one false positive was dismissed with the reason given below.

| Tool | What it checks | Result | Blocks CI |
| --- | --- | --- | --- |
| ESLint with security rules | Code quality and risky patterns | 0 problems | Yes |
| `npm audit` | Known vulnerable packages | 0 vulnerabilities | Yes |
| CodeQL (security-extended) | Data-flow analysis on GitHub | 5 of 6 alerts fixed; 1 false positive dismissed; 0 open | Reported in the Security tab |
| Semgrep (6 rule packs) | Static analysis of every project file | 0 findings | Yes |
| gitleaks | Secrets in every commit | 0 leaks, 1 reviewed false positive | Yes |
| Trivy, project | Packages, Dockerfile, secrets | 0 HIGH or CRITICAL | Yes |
| Trivy, app image | Everything in the shipped image | 0 HIGH or CRITICAL | Yes |
| Trivy, Caddy and Percona MongoDB images | Third-party images | Open findings, below | No, reported |
| OWASP ZAP baseline | The public pages of the running app, passively, on the private container network | 0 failures, 0 warnings, 63 rules passed | Yes |
| OWASP ZAP active API scan | Attack requests against all 66 documented API paths, signed in as an Admin; 222 URLs, capped at 15 minutes | 0 failures, 0 server errors, 119 rules passed; 2 low warnings accepted below | Yes |
| actionlint | CI workflow files | 0 problems | No, run by hand |
| Tests with coverage | Every control | 381 of 381 pass; 97.8% of lines | Yes |
| Attack replay | The 30 attacks in the Burp test script, over HTTPS against the production stack | [All refused as expected](ATTACK-REPLAY-RESULTS.md), after one finding fixed | Yes |
| Recovery drill | Back up, destroy, restore, compare | Data, photo and counts restored | Yes |
| Failover drill | Kill the database primary on the three-member stack | A new primary served writes after about 10 seconds | Yes |
| Load test | Staff requests during a flood | No staff request failed ([details](LOAD-TEST.md)) | No, reported |

## What the scans found, and what was done

| Found by | Finding | Outcome |
| --- | --- | --- |
| Semgrep | AES-GCM decryption did not fix the tag length, so a shortened tag could be accepted | Fixed: the full 16-byte tag is required, with a test |
| ZAP | With no JavaScript, the sign-in form would put the password in the URL | Fixed: every form uses POST, with a test |
| ZAP | `Cross-Origin-Embedder-Policy` header missing | Fixed |
| Header check | `X-Frame-Options` disagreed with the CSP | Fixed: both now refuse framing |
| ESLint | Asset path pattern could backtrack badly | Rewritten with no nested repetition |
| ESLint | A category named `__proto__` was mishandled in reports | Fixed: uses a Map |
| Trivy | The Node base image carried dozens of HIGH findings and a bundled npm | Fixed: moved to a distroless image, with no shell or npm |
| CodeQL | Backtracking patterns in the password check, a file race in `setup-env`, incomplete table escaping | Fixed |
| Load test | Public menu requests could flood the database | Fixed: 5-second cache and a tighter per-address limit |
| Attack replay | The kitchen's data included the cafe's public phone number | Fixed: the kitchen receives only the cafe's name, with a test |
| Recovery drill | Upload and backup folders were not writable in the new image | Fixed, and photo upload added to the end-to-end check |

## Accepted, with reasons

These are recorded so that the exceptions are visible and can be reviewed.

| Tool and rule | Reason |
| --- | --- |
| gitleaks, `tests/config.test.js` in commit aae2d37 | A fake value decoding to "secret-value-that-must-not-leak". The test now builds it at run time |
| ESLint `detect-object-injection` (off) | Flags every `obj[key]`. All 31 server and script uses were reviewed; each is a fixed key, a number or guarded by `Object.hasOwn` |
| ESLint `detect-non-literal-fs-filename` | Each server use has a written reason in the code; paths never come from a request |
| CodeQL `js/missing-token-validation` | False positive: CodeQL recognises only certain CSRF libraries. The app refuses other origins in `csrfOriginProtection`, checks a per-session `X-CSRF-Token` in `requireAuth`, and uses a `SameSite=Strict` cookie, all tested |
| ZAP 10027, suspicious comments | Matches ordinary comments containing words such as "from" |
| ZAP 10049, storable content | Intended: pages revalidate with ETag, and API responses are `no-store` |
| ZAP 10109 and 10111 | Informational: the site uses JavaScript, and it has a sign-in form |
| ZAP 2, private IP disclosure (active scan) | Intended: the audit log and device list record each request's address. Only Admins, or the account's owner, see them. In the scan the addresses were the test containers' own |
| ZAP 100001, unexpected content type (active scan) | Expected: CSV exports are `text/csv` and unknown paths return the HTML error page; the rule assumes every response is JSON |
| ZAP 10202, no CSRF token in forms | A native form post returns 404; real requests use `fetch` with the CSRF header and an Origin check |

## Open findings in third-party images

No fixed image existed on 9 November 2026. Dependabot proposes new digests as soon as the publishers release them.

| Image | Finding | Why the risk is low here |
| --- | --- | --- |
| Caddy 2.11.9 | CVE-2026-78661, `golang.org/x/net/html` denial of service | That library parses HTML, used by a Caddy feature this setup does not enable |
| Percona MongoDB 7.0 | CVE-2026-78661, `golang.org/x/net` in `mongodump`, similar tools and the telemetry agent | Those tools are never run in this stack, and telemetry is turned off |
| Percona MongoDB 7.0 | CVE-2026-114406, `ca-certificates` | The database makes no outbound connections: it has no route to the internet and no published port |
| Percona MongoDB 7.0 | CVE-2026-77214, `expat` | MongoDB does not parse XML from clients, and only the app can reach the container |

## How the scans were run

Each tool ran from the same image digest that CI uses, against the code in this repository and a local copy of the production stack. The active scan is automated and time-capped, and about two-thirds of its requests were correctly refused by permission checks and rate limits, so it does not go deep into every route. The 30 attacks in [BURP-TEST-SCRIPT.md](BURP-TEST-SCRIPT.md) were also sent through Burp Suite's proxy and refused; hand testing in Repeater has not been done.
