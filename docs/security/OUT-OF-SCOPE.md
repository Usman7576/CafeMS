# Out of scope

**Six lecture topics cannot be built inside a web application, so CafeMS does not claim them.** Each is listed with who is responsible and what the app does within its own limits.

| Topic (deck) | Why it is outside the app | Who is responsible | What CafeMS does |
| --- | --- | --- | --- |
| Network firewall (Week 2, slide 25) | It controls which ports of the server are open | The hosting provider and the server's owner | A web application firewall with the OWASP Core Rule Set runs in Caddy; only Caddy is reachable; `docs/DEPLOYMENT.md` says to open only ports 22, 80 and 443 |
| Cloud-scale DDoS protection (Week 2, slide 13) | A flood larger than the server's connection must be stopped before it arrives | A provider such as Cloudflare | Edge rate limits in Caddy, the app's own limits, a separate staff process and a public cache. [LOAD-TEST.md](LOAD-TEST.md) has the measured effect |
| 99.9% uptime guarantee (Week 2, scenario 4) | Uptime depends on the host, power and network | The hosting provider | Health checks, automatic restarts, graceful shutdown, and backups with a tested restore |
| Cyber terrorism (Attackers, slide 6) | A cafe is not critical infrastructure, so there is nothing specific to build | Recorded as an accepted risk in [RESIDUAL-RISKS.md](RESIDUAL-RISKS.md) | The general controls still apply |

**Simulated services.** The payment gateway and SMS or email delivery are simulated, because real ones need a merchant or provider account. Their boundaries are built as a real integration needs them: timeouts, signed single-use callbacks, retries and alerts. `docs/DEPLOYMENT.md` says what must be connected before real customers use the site.

**Moved into the app since:** fingerprint, face or PIN sign-in through passkeys (Week 2, scenario 11), and email sent only over verified TLS (scenario 6). Physical access control, such as door locks, stays with the cafe's owner.
