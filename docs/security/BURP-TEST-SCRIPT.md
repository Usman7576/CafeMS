# Burp Suite manual test script

**This script takes about 45 minutes and tests what automated scanners cannot judge: whether one person can reach another person's data or skip a business rule.** Run it only on your own local copy, never on a live site.

## Set up

1. Start the app locally with `npm start`, after `docker compose up -d --wait`.
2. Create test accounts with `npm run seed:dev`, and sign in once as each role to enrol an authenticator.
3. In Burp Suite Community, open the built-in browser from the Proxy tab. Turn **Intercept** off until a step needs it.
4. Sign in as a Waiter and click around the app, so requests appear in **Proxy > HTTP history**.

**How to test:** right-click a request, choose **Send to Repeater**, edit it, then press **Send**. A state-changing request also needs the current `X-CSRF-Token` header, which you get from the original request.

Record each result in the table at the end. Every test below should be **refused**.

## Tests

### Authentication and sessions

| # | Do this | Expected |
| --- | --- | --- |
| 1 | Send `POST /api/v1/auth/login` with a wrong password three times, then the right one | 401 every time: the account is locked |
| 2 | With Intruder or Repeater, send 25 wrong logins for different usernames | 429 after about 20 |
| 3 | Change the session cookie's value by one character on `GET /api/v1/auth/me` | 401 |
| 4 | Change the token's header to `{"alg":"none"}` and remove the signature | 401 |
| 5 | Sign out, then replay an earlier request with the old cookie | 401 |
| 6 | Sign in, skip `/auth/mfa/verify`, and call `/api/v1/snapshot` | 401 |
| 7 | Replay a used authenticator code on `/auth/mfa/verify` | 401 |

### Authorization

Use a Waiter's cookie and CSRF token unless a step says otherwise.

| # | Do this | Expected |
| --- | --- | --- |
| 8 | `GET /api/v1/users`, `/api/v1/audit` and `/api/v1/reports/sales` | 403, and an "Access denied" audit entry |
| 9 | `POST /api/v1/billing/tables/1/pay` | 403 |
| 10 | As Waiter A, `PUT /api/v1/orders/<Waiter B's order ID>` | 404: it looks as if it does not exist |
| 11 | As a Cashier, `GET /api/v1/bills/<yesterday's bill>` | 404 |
| 12 | As a Kitchen user, `GET /api/v1/snapshot`, and search the response for `price` and `phone` | Neither appears |
| 13 | As a Manager, `POST /api/v1/bills/<no>/refund` with no recent code | 403 `step_up_required` |
| 14 | As a Manager, approve your own large refund | 403 `same_person` |

### Input and business rules

| # | Do this | Expected |
| --- | --- | --- |
| 15 | On `POST /api/v1/orders`, add `"total": 1` or `"price": 1` to the body or a line | 400 |
| 16 | Set `"qty": -5`, then `0`, `1.5`, `100` and `"1"` | 400 each time |
| 17 | Log in with `{"username":{"$ne":null},"password":{"$ne":null}}` | 401 |
| 18 | As a Cashier, send `"discountPct": 50` on a payment | 403 and an audit entry |
| 19 | Resend the same `Idempotency-Key` with the same body | The first result, and no second record |
| 20 | Resend that key with a different body | 422 |
| 21 | Reserve a table with the name `<img src=x onerror=alert(1)>`, then open the staff list | Shown as plain text, with no alert |

### CSRF and headers

| # | Do this | Expected |
| --- | --- | --- |
| 22 | Remove `X-CSRF-Token` from a change | 403 |
| 23 | Change `Origin` to `https://evil.example` | 403 |
| 24 | Remove the `Origin` header | 403 |
| 25 | Check any page's response headers | CSP with no `unsafe-inline`, `X-Frame-Options: DENY`, `nosniff` |

### File upload (as an Admin)

| # | Do this | Expected |
| --- | --- | --- |
| 26 | `PUT /api/v1/menu/1/photo` with an HTML body and `Content-Type: image/png` | 415, and recorded |
| 27 | Upload an SVG with `Content-Type: image/svg+xml` | 415 |
| 28 | Upload a body over 2 MB | 413 |

### Payment callback

| # | Do this | Expected |
| --- | --- | --- |
| 29 | `POST /api/v1/payments/callback` with no signature | 401, and recorded |
| 30 | Send the correct signature twice, using a helper script | 204, then 409 |

## Results

Copy this table into your submission, with your screenshots.

| # | Date | Result: pass or fail | Notes |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |

Anything that is **not** refused is a finding. Add a failing test for it, fix it, and record it in the review log in `SECURITY-REQUIREMENTS.md`.
