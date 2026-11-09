# Residual risks

**These are the risks that remain after every planned control, listed so they can be accepted or fixed on purpose.** No system is free of risk. The two that matter most before real customers use the site are the simulated payment gateway and running a single database. The Week 4 process expects these to be reviewed whenever the design changes. Last reviewed: 9 November 2026.

| Risk | Level | Why it remains | What reduces it | Fix or review when |
| --- | --- | --- | --- | --- |
| Payment gateway is simulated, so Card and Wallet bills are marked Paid with no money moving | High until connected | A real gateway needs a merchant account | Clearly stated in `DEPLOYMENT.md`; the signed, timed-out boundary is built | Take cash only, or connect a provider before going live |
| SMS and email are simulated | Medium | A real provider needs an account | Messages are queued and retried; failures raise an alert | Before relying on receipts or notices |
| One database on one server | High if the server fails | Three members need three machines | Encrypted backups, a tested restore and off-site copies | Use a managed database or three members for real trade |
| A very large flood slows staff screens | Medium | One server process shares its CPU with the traffic; the Week 4 example of 10% is not met | Limits, a public cache; no staff request failed in [LOAD-TEST.md](LOAD-TEST.md) | Add Cloudflare or similar if attacked |
| Rate-limit counters live in memory | Low | One app container is enough for a cafe | Counters reset only on restart | Before running more than one app container |
| Upstream findings in the Caddy and MongoDB images | Low | No fixed images exist yet | Details in [SCAN-RESULTS.md](SCAN-RESULTS.md); Dependabot proposes updates | When publishers release fixes |
| A Manager can refund up to Rs 5,000 alone | Medium | A second person for every refund would stall service | Fresh code for each refund, a refund-spike alert, signed audit trail | If refund abuse appears |
| A dishonest Admin, or two working together | Medium | Someone must be able to administer the system | Second Admin rule, signed audit log, append-only database account | Choose Admins carefully |
| Someone with the database administrator password can remove the whole log tail | Medium | The chain detects changes, but a full rollback of log and head needs an outside copy | The chain's latest hash is written to the application logs every 15 minutes; backups are off-site | Send logs to a separate service for real trade |
| Password reuse or phishing of staff | Medium | People are outside the system's control | MFA for everyone, lockout, common-password refusal | Staff training |
| An unattended shared device | Low | A shorter limit would sign staff out mid-order | 5-minute idle limit and a device list with revoke | If staff report misuse |
| Argon2 can fail under severe memory pressure | Low | The hash deliberately uses 19 MB per check | It fails closed: sign-in is refused, never allowed | Use a server with at least 2 GB of memory |
| Masked numbers are stored unencrypted (first four and last two digits) | Low | Staff screens need them on every refresh | The rest of the number is encrypted; erased with the record | Accepted |
| Security log keeps network addresses with no time limit | Low | Needed for accountability; a signed chain cannot be trimmed | Disclosed in the privacy notice; holds no names or numbers | Review if the law requires a limit |
| A menu edit from two Admin screens: the later save wins | Low | Few Admins, and each change is audited | Audit log shows both changes | If more Admins are added |
| Reservation staff can move a booking between any open status | Low | Staff correct mistakes this way | Every change is audited; closed and erased bookings cannot change | Accepted |
| New menu items have no recipe, so they never reduce stock | Low | The screens do not edit recipes yet | Staff can adjust stock by hand | Feature for later |
| Cyber terrorism and nation-state attack | Very low | A cafe is not a target of this kind | General controls, pinned supply chain | Accepted |
| Manual Burp Suite test not yet run | Open | It needs a person | [BURP-TEST-SCRIPT.md](BURP-TEST-SCRIPT.md) gives the steps | Before submission |
