# Development Activity 6 — Backend Development and Integration

**Project:** Cafe Management System (CafeMS), the same semester project as Activities 1–5
**Backend:** Node.js 24 + Express 5 · **Database:** MongoDB (replica set, for transactions) · **Auth:** Argon2id + signed JWT (HS256)

**Student:** M. Usman (22L-7991). This is an individual project, so I built both modules myself.

| Module | Frontend pages | Backend code |
| --- | --- | --- |
| **Module 1 — Reservations** | `reservation.html`, `reservations.html`, public booking form on `index.html` | `server/services/reservations.js`, reservation routes in `server/routes/business.js` and `server/routes/public.js` |
| **Module 2 — Orders and kitchen** | `order.html`, `dashboard.html`, `kitchen.html` | `server/services/orders.js`, order, table and kitchen routes in `server/routes/business.js` |
| **Shared — Login, registration and staff accounts** | `login.html`, `register.html`, `users.html` | `server/routes/auth.js`, `server/routes/public.js` (`/register`), `server/services/users.js` |

The activity asks each group member to build a different module. As the only member, I built both modules on their own and then integrated them. They run in the **same** Express app against the **same** MongoDB database: an order placed in Module 2 appears on the kitchen board, and both modules share the login, JWT session, role table and audit log.

---

## Task 1 — Backend setup and database connectivity

| Requirement | Where it is done |
| --- | --- |
| 1. Backend server runs | `npm start` → `server/index.js` starts Express on port 3000 (`server/app.js`) |
| 2. Database connection | `server/db.js` → `createClient()`; refuses to start without a replica set; `/api/health` pings MongoDB |
| 3. Collections for the modules | `server/db.js` `COLLECTIONS` creates `reservations`, `orders`, `menu`, `inventory`, `users`, `sessions`, … with indexes (e.g. one active booking per phone/date/time) |
| 4. Data is stored | Evidence **A6-13, A6-14** (reservation saved, read back from MongoDB), **A6-20** (order saved) |
| 5. Data is retrieved | Evidence **A6-15** (`GET /reservations`), **A6-21** (`GET /orders`), **A6-23** (kitchen reads the same order) |

**Database setup scripts** (submission item 2): `npm run setup:env` (keys and passwords), `docker compose up -d --wait` (MongoDB), `npm run db:setup` (least-privilege app login, collections, indexes; `scripts/db-setup.js`), `npm run seed:dev` (menu, stock and staff accounts). Encrypted backups: `npm run backup` → `backups/`.

## Task 2 — Individual backend modules

| Requirement | Module 1: Reservations | Module 2: Orders |
| --- | --- | --- |
| Insert | `POST /api/v1/reservations` (staff), `POST /api/v1/public/reservations` (customers) | `POST /api/v1/orders` |
| Retrieve | `GET /api/v1/reservations`, `POST /api/v1/reservations/search` | `GET /api/v1/orders`, `GET /api/v1/kitchen/tickets`, `GET /api/v1/tables` |
| Update / delete | `POST /api/v1/reservations/{id}/status` | `PUT /api/v1/orders/{id}`, `/serve`, `/cancel`, `/api/v1/kitchen/tickets/{id}/status` |
| Success handling | `201` + saved record; `200` on update | `201` + order with server-worked totals |
| Failure handling | `400 invalid_input` with a friendly message, `409` on a duplicate or same status, `403`/`401` | `400` on bad input or a browser-sent price, `409` once the kitchen has started, `403`/`401` |

The full list of 92 endpoints, with who may call each one, is in [docs/activity-6/API-ENDPOINTS.md](docs/activity-6/API-ENDPOINTS.md) (submission item 3). It is generated from the live router, so it matches the code.

## Task 3 — Frontend–backend integration

There is no mock or hard-coded data left in the frontend. `public/js/store.js` is a thin API client: every read comes from `GET /api/v1/snapshot` and every change is a request to the server, which decides whether it is allowed. Nothing is kept in `localStorage`.

| Requirement | How |
| --- | --- |
| Forms send data to the backend | `reservation.js` → `Store.addReservation` → `POST /reservations`; `order.js` → `Store.place` → `POST /orders`; `login.js` → `POST /auth/login` |
| Stored records are shown | `reservations.js` and `dashboard.js` render the server's list; refreshed every 3 s |
| Success and failure handled | `CMS.attempt()` in `common.js` shows the server's message for any `4xx` and a reference number for a `5xx`; `CMS.toast(…, "ok")` on success; a `401` sends the user back to sign-in |

## Task 4 — Authentication and JWT

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| 1. Backend login | `POST /api/v1/auth/login` then `POST /api/v1/auth/mfa/verify` (`server/routes/auth.js`) | A6-03 |
| 2. Credentials checked on the server | `verifyPassword()` in `server/lib/passwords.js`; same generic error for an unknown user or wrong password; lockout after 3 failures | A6-02 |
| 3. Passwords hashed | Argon2id (19 MiB, 2 passes), never stored in plaintext | A6-01 |
| 4. Signed JWT after login | `sessions.create()` signs `{ jti, sub, iss, aud, exp }` with HS256 and a key ID, set as a `__Host-` HttpOnly, Secure, SameSite=Strict cookie (`server/services/sessions.js`) | A6-03 |
| 5. JWT checked on protected routes | `requireAuth` (`server/middleware/auth.js`) verifies signature, algorithm, issuer, audience and expiry, then the server session record | A6-04 |
| 6. Missing, invalid or modified tokens refused | Any verification failure → `401 not_signed_in` | A6-05 to A6-12 |
| Registration | **Register** button on the landing page → `register.html` → `POST /api/v1/public/register`. The account is stored as *Pending* with an Argon2id hash and cannot sign in. An Admin approves it on *Staff & roles* and chooses the role (never Admin). It then signs in and adds an authenticator app | A6-32 to A6-39 |

## Task 5 — Authorization and secure data handling

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| 1. Role-based authorization | One permission table, `server/lib/permissions.js`; every route carries `allow("permission")`; a test fails if any route has no guard | A6-24 to A6-30 |
| 2. No actions outside a role | `403 forbidden` plus an "Access denied" audit entry; roles are re-read from the database on every request | A6-24 to A6-28, A6-31 |
| 3. Server-side validation | Strict Zod schemas (`server/lib/schemas.js`): types, lengths, real dates, unknown fields refused | A6-16, A6-18, A6-22 |
| 4. Injection prevented | Schemas allow only strings and numbers, so `{"$ne": ""}` operator objects never reach MongoDB; queries use fixed field names | A6-17 |
| 5. No technical details in errors | Central error handler in `server/app.js`: only messages written for users are shown; anything else becomes a generic message and a reference number, with the detail kept in the server log | A6-40, A6-41 |

## Task 6 — Testing and demonstration

Run the evidence (uses a throwaway in-memory database; nothing touches real data):

```bash
node scripts/activity6-evidence.js
```

It writes [docs/activity-6/TEST-RESULTS.md](docs/activity-6/TEST-RESULTS.md) and `test-results.json`. **All 41 cases pass.** The same cases run in `npm test` as `tests/activity6.test.js`.

| Demonstration item | Cases |
| --- | --- |
| 1. Login and JWT generation | A6-01 to A6-03; registration and approval A6-32 to A6-39 |
| 2. Protected endpoint with a valid token | A6-04 |
| 3. Invalid or missing token refused | A6-05 to A6-12 |
| 4. Role-based restrictions | A6-24 to A6-31, A6-35 to A6-37 |
| 5. Submit and retrieve through the backend | A6-13 to A6-15, A6-19 to A6-23 |
| 6. Both modules | Module 1: A6-13 to A6-19 · Module 2: A6-20 to A6-23 |

### Live demonstration script (in the browser)

0. **Register:** on the landing page click **Register**, request an account → "waiting for approval". Try to sign in with it → refused. Sign in as **Admin**, open *Staff & roles*, click **Approve**, pick a role → the new account can now sign in.
1. `npm start`, open http://localhost:3000, click **Sign in** and sign in as a **Waiter**. In DevTools → Application → Cookies, show the `__Host-cms_session` JWT; paste it into jwt.io to show the `HS256` header and claims.
2. **Module 1:** open *New reservation*, submit a booking → green toast; open *Reservations* → the new row is listed (read back from MongoDB). Submit a party of 50 → red message from the server.
3. **Module 2:** open *New order*, add items to a table, send → it appears on the dashboard; sign in as **Kitchen** in another browser → the ticket is there.
4. **Tokens:** in DevTools, edit one character of the cookie and reload → sent back to sign-in (`401`). Delete the cookie → same.
5. **Roles:** as the Waiter, open `http://localhost:3000/audit.html` → the server sends them back to their own dashboard. In DevTools → Console run `fetch("/api/v1/audit").then(r => r.status)` → `403`. As Admin, the audit log shows the "Access denied" entry.

Screenshots of steps 0–5 are the evidence for submission items 4–6.
