## What changed and why

<!-- One or two sentences. -->

## Security review checklist

Tick each one, or say why it does not apply. This is the code review the course's secure development process expects; CI covers the automated part.

**Access and input**
- [ ] Every new route has a guard and appears in the permission test
- [ ] Ownership is enforced in the query, not only in the browser
- [ ] Input is validated by a strict schema; unknown fields are refused
- [ ] Prices, totals and roles come from the server, never the request

**Data**
- [ ] Personal data is encrypted at rest and masked for roles that do not need it
- [ ] No secrets, tokens, passwords or personal data in code, logs, URLs or error messages
- [ ] Multi-step changes run in a transaction, with the audit entry in the same transaction

**Browser**
- [ ] No `innerHTML`, inline scripts or styles, or third-party resources

**Evidence**
- [ ] Tests prove the new behaviour, including the way it could be abused
- [ ] New requirements or threats are added to `docs/security/traceability.json` (`npm run trace`)
- [ ] The risk register is updated if exposure or a failure mode changed
