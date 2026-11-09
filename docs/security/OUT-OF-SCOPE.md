# Out of scope

**Six lecture topics cannot be built inside a web application, so CafeMS does not claim them.** Each is listed with who is responsible and what the app does within its own limits.

| Topic (deck) | Why it is outside the app | Who is responsible | What CafeMS does |
| --- | --- | --- | --- |
| Firewalls and intrusion detection (Week 2, slide 25) | They protect the network the app runs on | The hosting provider and the server's owner | The database sits on a private network with no route out; only Caddy is reachable. `docs/DEPLOYMENT.md` says to open only ports 22, 80 and 443 |
| Cloud-scale DDoS protection (Week 2, slide 13) | A large flood must be stopped before it reaches the server | A provider such as Cloudflare | Limits per address, per person and for pages; a short cache on public data. [LOAD-TEST.md](LOAD-TEST.md) has the measured effect |
| 99.9% uptime guarantee (Week 2, scenario 4) | Uptime depends on the host, power and network | The hosting provider | Health checks, automatic restarts, graceful shutdown, and backups with a tested restore |
| Biometrics and physical security (Week 2, scenario 11) | They control access to a place, and a cafe web app has no such hardware | The cafe's owner | Authenticator-based MFA for every member of staff |
| Encrypted email (Week 2, scenario 6) | The app sends no email | Not applicable | Queued messages hold a reference only, never a name or number |
| Cyber terrorism (Attackers, slide 6) | A cafe is not critical infrastructure, so there is nothing specific to build | Recorded as an accepted risk in [RESIDUAL-RISKS.md](RESIDUAL-RISKS.md) | The general controls still apply |

**Simulated services.** The payment gateway and SMS or email delivery are simulated, because real ones need a merchant or provider account. Their boundaries are built as a real integration needs them: timeouts, signed single-use callbacks, retries and alerts. `docs/DEPLOYMENT.md` says what must be connected before real customers use the site.
