# Plan: CafeMS as a complete, full-stack Cafe Management System

**Project:** CafeMS · **Author:** M. Usman (22L-7991) · **Date:** 25 November 2026
**Goal:** turn the current coursework app into a complete cafe system that a real cafe could run on every day. It should have:
- a simple, modern UI;
- a local MongoDB (no Docker);
- every core cafe workflow, from the first coffee to the end-of-day report.

---

## 1. Where the project is today

| Area | What exists now | Verdict |
| --- | --- | --- |
| Public website | Landing page, live menu with photos, online table request, register, privacy page | Keep, redesign |
| Ordering | Waiter takes and edits orders per table; prices from the server | Keep, extend (item options, takeaway, notes per item) |
| Kitchen | Ticket board New → Preparing → Ready | Keep, extend (stations, timers, recall) |
| Billing | Cash, card, wallet; role-limited discounts; refunds with approval; receipt | Keep, extend (split bill, tips, service charge, shifts) |
| Inventory | Ingredients, recipes, automatic stock deduction, restock or write-off | Keep, extend (suppliers, purchase orders, stock count, costs) |
| Reports | Sales by hour, payment split, best sellers, CSV | Keep, extend (profit, staff, daily close, charts) |
| Reservations | Staff and online bookings, status queue | Keep, extend (floor plan, time slots, waitlist) |
| Staff | Users, roles, invitations, registration with approval | Keep, extend (shifts, clock in/out, timesheets) |
| Staff requests | Requests with review workflow (quiz Q2/Q3) | Keep as "Maintenance & supply requests" |
| Security | Argon2id, JWT sessions, TOTP for everyone, passkeys, OIDC, signed actions, hash-chained audit log, encryption, rate limits | Keep the core, simplify the rest (see section 3) |
| Infrastructure | Docker MongoDB, Docker deploy stack, Caddy, CI scanners | Remove Docker; use local MongoDB |
| UI | 22 separate pages, custom CSS, three.js 3D coffee animation, screens refresh every 3 seconds | Replace with a new design and live updates |

Hard-coded values that must move into settings:
- the 10 tables;
- the 16% tax rate;
- the discount limits;
- the time zone;
- the cafe details.

---

## 2. Phase 0: Move from Docker to your local MongoDB (do first)

Your machine already has **MongoDB Server 9.0** running as a Windows service on `127.0.0.1:27017`, with **MongoDB Compass**. Two facts matter:

1. **It runs as a standalone server.** CafeMS uses **transactions** (orders, payments, requests, audit). MongoDB allows transactions only on a **replica set**, so the local server must become a single-node replica set. This is a one-time change. Your other database on it (`fraudguard`) keeps working and is not touched.
2. **It has no login enabled.** Anyone on this computer can open every database. The plan turns on authentication, with an admin login and a limited login for the app.

**Steps**

| # | Step | How |
| --- | --- | --- |
| 0.1 | Back up the current data from Docker | `npm run backup` (encrypted). Also export a plain copy with `mongodump` for Compass. |
| 0.2 | Make the local server a replica set | Add `replication: { replSetName: rs0 }` to `C:\Program Files\MongoDB\Server\9.0\bin\mongod.cfg`, restart the "MongoDB" service (needs Administrator), then run `rs.initiate()` once in Compass's shell. |
| 0.3 | Turn on authentication | Create an admin user in Compass, add `security: { authorization: enabled }` and a key file to `mongod.cfg`, restart. *(Optional but recommended.)* |
| 0.4 | Point the app at it | `.env`: `MONGODB_URI=mongodb://cafems_app:…@127.0.0.1:27017/cafems?replicaSet=rs0&authSource=cafems`. Run `npm run db:setup` to create the app login, collections and indexes. |
| 0.5 | Restore the data | `npm run restore` into the empty `cafems` database. Check users, orders and photos in Compass. |
| 0.6 | Remove Docker | Delete `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `deploy/` (Caddy, HA stack), `.mongo-keyfile`; remove Docker steps from scripts, CI, tests and docs. |
| 0.7 | New one-command setup | `npm run setup` checks that MongoDB is running as a replica set, creates `.env` keys, the app login, indexes and seed data, then prints the staff logins. |

**Done when:**
- `npm start` works with Docker Desktop closed;
- Compass shows the `cafems` database with all collections;
- all tests pass.

The tests keep using the in-memory MongoDB, so they never touch your real data.

---

## 3. What to remove or simplify

| Remove / simplify | Why | Replacement |
| --- | --- | --- |
| **Docker everything** (Dockerfile, compose files, Caddy, HA stack, Trivy/ZAP container jobs, deployment tests) | You run MongoDB locally; Docker adds setup pain | Local MongoDB + `npm start`; a plain "Deploy to a server" guide for later |
| **three.js 3D coffee animation** (~600 KB) | Slow on cheap tablets, distracts in a work tool | A real cafe photo hero on the public site; nothing animated in staff screens |
| **Screens refreshing every 3 seconds** | Wasteful, and changes show up late | Live updates (section 5) |
| **Risk register page** | Coursework artifact, not a cafe feature | Keep the document in `docs/`; remove the page |
| **OIDC "organisation account" sign-in** | No provider is configured; the button does nothing for a cafe | Remove the button and service (can return later) |
| **Per-device action signatures (Ed25519 signing keys)** | Complex, confusing for staff, hard to recover when a tablet is lost | Keep a fresh authenticator code (step-up) for refunds, large discounts, role changes |
| **IP-country lookup database** (large package) | Little value for a single cafe | Keep new-network sign-in alerts, without country |
| **Authenticator code for every role** | Slows down waiters and kitchen on shared tablets | Required for Admin and Manager; optional for others, plus a quick **PIN switch** on the POS (section 4.10) |
| **22 separate HTML pages with duplicated layout** | Hard to keep consistent | One app shell with client-side routing (section 6) |
| Coursework write-ups at the project root (`SUBMISSION-*.md`) | Clutter | Move to `docs/coursework/` |

**Kept on purpose (the security core):**
- Argon2id passwords;
- JWT session plus a server session record;
- roles and permission checks on every route;
- strict input validation;
- CSRF protection;
- rate limits;
- encryption of customer phone numbers;
- the hash-chained audit log;
- transactions;
- encrypted backups.

---

## 4. What to add (by module)

Priority: **Must** = needed to run a cafe; **Should** = expected in a complete product; **Could** = later.

### 4.1 Menu and products
- **Must:**
  - Categories you can manage: add, rename, reorder, hide.
  - **Item options (modifiers)**, such as size (S/M/L), milk (whole, oat, almond), sugar level, extra shot, each with a price change.
  - Options that are required or optional, and how many can be chosen.
- **Should:**
  - Allergen and dietary tags (vegan, gluten-free, contains nuts).
  - Combos and meal deals.
  - "Sold out today" toggle.
  - Time-based menus (breakfast until 12:00).
  - Featured items on the website.
- **Could:**
  - Happy-hour pricing.
  - Item cost and margin shown to managers, from recipe costs.

### 4.2 Point of sale (POS) and orders
- **Must:**
  - A fast POS screen for tablets: categories on the left, items as large tiles, a cart on the right.
  - Item options and per-item notes.
  - Order types: **Dine-in** (table), **Takeaway** (name + number), **Delivery** (address, rider).
  - Hold an order and resume it.
  - Void an item, with a reason (logged).
  - Move or merge tables.
- **Should:**
  - Customer name on order.
  - Course timing ("send drinks now, food later").
  - Order numbers on a public "now serving" screen for takeaway.
- **Could:**
  - Offline mode: queue orders when the internet drops, sync later.

### 4.3 Kitchen and bar display
- **Must:**
  - **Stations**: drinks go to the bar screen, food to the kitchen screen.
  - Per-item "done" ticks.
  - Ticket timers with colour warnings.
  - Sound on a new ticket.
  - Recall a bumped ticket.
- **Should:**
  - Average preparation time per item (feeds reports).
  - "86" an item (sold out) from the kitchen.

### 4.4 Billing and payments
- **Must:**
  - **Split bill**: by item, by seat, or equally.
  - Partial payments, mixed methods (part cash, part card).
  - **Tips**.
  - **Service charge** (setting).
  - Taxes from settings.
  - Printable 80 mm receipt and a PDF/email receipt.
- **Must, shifts and cash drawer:**
  - Open a shift with a float.
  - Cash in/out entries with reason.
  - Close the shift with a counted amount.
  - **Z-report** (expected vs counted, over/short).
- **Should:**
  - Promo codes and vouchers.
  - Gift cards.
  - Card terminal / Stripe test mode in place of the simulated gateway.
- **Could:**
  - JazzCash / Easypaisa QR payments.

### 4.5 Customers and loyalty (new module)
- **Should:**
  - Customer profiles: name, phone (encrypted), visits, total spent.
  - **Loyalty points**: earn per Rs 100, redeem at billing.
  - Birthday offer.
  - Feedback after visit (1–5 stars + comment).
- **Could:**
  - Customer accounts on the website: order history, saved favourites.

### 4.6 Online ordering (public site)
- **Should:**
  - Order online for takeaway pickup or delivery.
  - Pick a time slot.
  - Order status page ("Preparing → Ready").
- **Should:** **QR table ordering**. Each table has a QR code that opens the menu for that table; orders go to the kitchen after staff confirm (protects against fake orders).
- **Could:** Pay online.

### 4.7 Inventory and purchasing
- **Must:**
  - **Suppliers**: contact, items supplied, lead time.
  - **Purchase orders**: create, send, receive (full or partial).
  - Received stock updates quantities and **cost**.
  - **Stock count (stocktake)**: count sheet, differences reported.
  - **Waste log** with reasons (expired, spilled, burnt).
- **Should:**
  - Unit conversions (buy in kg, use in g; buy cases, use pieces).
  - Average cost per ingredient → recipe cost → item margin.
  - Low-stock list that suggests a purchase order.
- **Could:**
  - Batch and expiry tracking.

### 4.8 Reservations and tables
- **Must:**
  - **Floor plan editor**: drag tables, set seats, areas (inside / terrace), saved in settings.
  - Live table status on the floor plan.
- **Should:**
  - Time slots with capacity.
  - Booking length.
  - **Waitlist** for walk-ins.
  - SMS/email confirmation (simulated or real provider).
  - No-show marking.

### 4.9 Staff and shifts (new module)
- **Must:**
  - **Clock in / clock out**: PIN on the POS tablet.
  - Timesheets per week.
- **Should:**
  - **Rota (schedule)**: managers plan weekly shifts, staff see their shifts.
  - Leave requests.
  - Hours export for payroll (CSV).
  - Tips share per shift.
- Keep: invitations, registration with approval, roles, account page.

### 4.10 Roles and fast switching
- New roles: **Barista** (bar station) and **Rider** (delivery) as optional roles.
- **PIN switch**:
  - On a shared POS tablet, staff tap their name and enter a 4–6 digit PIN to act as themselves.
  - The tablet itself stays signed in with a device session.
  - PINs are hashed, rate-limited and locked after failures.

### 4.11 Reports and dashboard
- **Must:**
  - **Today dashboard**: sales, orders, average ticket, top items, open tables, low stock, staff on shift.
  - **Daily close report**: sales by method, tax, discounts, refunds, tips, cash over/short.
  - Date-range filters.
- **Should:**
  - Product mix.
  - Sales by category, by staff, by hour/day.
  - **Profit report**: sales − ingredient cost.
  - Labour cost %.
  - Busiest hours heat map.
  - Export CSV and PDF.
- **Could:**
  - Email the daily report to the owner automatically.

### 4.12 Settings (new module)
- **Must:**
  - Cafe profile: name, logo, address, hours.
  - Tax rates, service charge, currency (Rs), time zone.
  - Receipt header and footer.
  - Order types on or off.
  - Discount limits per role.
  - Tables and areas.
- **Should:**
  - Printers (receipt and kitchen).
  - Notification settings.
  - Data retention period.
  - Backup schedule.

### 4.13 Notifications
- **Must:**
  - Live updates everywhere: new order → kitchen, ready → waiter, bill requested → cashier, low stock → manager.
  - Notification bell with history.
- **Should:**
  - Browser push notifications on the manager's phone (installable web app).

---

## 5. Technical changes

| Area | Today | Change to |
| --- | --- | --- |
| Database | MongoDB in Docker on port 27018 | Local MongoDB 9.0 replica set on 27017, managed in Compass |
| Live data | Every screen re-downloads a snapshot every 3 s | **Server-Sent Events** stream per role (`/api/v1/events`); the screen updates when something changes |
| Settings | Constants in `server/lib/domain.js` | `settings` collection, cached in memory, edited on the Settings page |
| Frontend | 22 HTML pages, vanilla JS, custom CSS | **React + Vite + Tailwind CSS** single-page app served by Express (recommended), or keep vanilla JS with a new CSS design system (lighter option) |
| API | `/api/v1/...` (keep) | Add the new modules below; keep the guard on every route |
| Money | Integers (rupees) | Keep integers; add tips, service charge and rounding rules in one billing module |
| Files | Menu photos only | Also logo, receipt logo, supplier documents (same safe upload rules) |
| Printing | Browser print of the receipt | 80 mm receipt layout + kitchen ticket layout (print from the browser; ESC/POS printers later) |
| Installable app | No | PWA manifest so tablets can "install" CafeMS full-screen |

**New collections:**
- `categories`, `modifiers` (option groups), `customers`, `loyalty_ledger`, `suppliers`, `purchase_orders`, `stock_counts`, `waste_log`;
- `shifts` (cash drawer), `cash_movements`, `timesheets`, `rota`, `floor_plan`, `vouchers`, `feedback`;
- `notifications` (exists).

**New API groups:**
- `/categories`, `/modifiers`, `/pos/orders` (types, hold, void, transfer), `/bills/split`, `/shifts`;
- `/customers`, `/loyalty`, `/suppliers`, `/purchase-orders`, `/stock-counts`, `/waste`;
- `/timesheets`, `/rota`, `/floor-plan`, `/settings`, `/reports/*`;
- `/public/orders` (online ordering), `/public/table/:code` (QR).

---

## 6. The new UI: simple and modern

**Design principles:**
- Clean and calm, with lots of white space.
- One accent colour.
- Big touch targets on the POS.
- Every screen answers "what do I do next?".
- Works on a 10" tablet, a laptop and a phone.

**Design system:**
- **Font:** Inter (UI) + one display font only on the public site.
- **Colours:**
  - neutral greys (#F8F7F5 background, #FFFFFF cards, #1C1917 text);
  - one accent, coffee brown **#8B5E3C** (or the modern alternative, emerald **#10B981**);
  - status colours green, amber, red, blue used only for status.
- **Shape:** 12 px rounded corners, soft 1 px borders instead of heavy shadows, 8 px spacing grid.
- **Components:** sidebar, top bar, cards, data table with search/filter/pagination, tabs, drawer (side panel) for details, modal for confirmations, toast messages, empty states, skeleton loaders.
- **Dark mode** for the kitchen and bar screens (easier on the eyes) and as a user option.
- **Icons:** Lucide (one consistent set).

**Layout:**
- **Staff app:**
  - a collapsible left sidebar grouped by work (Sell · Kitchen · Manage · Reports · Settings), showing only what the role may use;
  - a top bar with search, notifications, shift status and the user menu.
- **POS (full-screen):**
  - left: category pills; centre: item tiles with photos; right: the cart with order type, table or customer, totals, and a big Pay/Send button;
  - item options open in a bottom sheet.
- **Kitchen / bar display:** dark full-screen columns (New · Preparing · Ready), big readable tickets, tap to bump.
- **Manager dashboard:** 4 stat cards on top, a sales chart, then lists (low stock, open tables, staff on shift).
- **Public website:** a photo hero, menu with filters and dietary tags, "Order online" and "Book a table" as the two main buttons, opening hours, map, footer.

**Screens to design (first pass):**
1. Sign in.
2. PIN switch.
3. POS.
4. Kitchen display.
5. Tables / floor plan.
6. Orders list.
7. Billing / payment.
8. Shift open/close.
9. Dashboard.
10. Menu manager.
11. Inventory.
12. Purchase orders.
13. Reservations.
14. Customers.
15. Staff & rota.
16. Reports.
17. Settings.
18. Public home.
19. Online order.
20. Order status.

**Accessibility:**
- WCAG AA contrast;
- full keyboard use;
- visible focus;
- labels on every field;
- respects "reduce motion".

---

## 7. Roles and permissions (updated)

| Area | Waiter | Barista | Kitchen | Cashier | Manager | Admin |
| --- | --- | --- | --- | --- | --- | --- |
| POS: take orders | ✓ | ✓ | | ✓ | ✓ | |
| Kitchen / bar display | | Bar | Kitchen | | ✓ (view) | |
| Billing, split, tips | | | | ✓ | ✓ | |
| Refunds, voids | | | | Request | ✓ (step-up) | |
| Shifts / cash drawer | | | | Own shift | All | |
| Reservations, waitlist | ✓ | | | ✓ | ✓ | |
| Customers, loyalty | Look up | | | ✓ | ✓ | ✓ |
| Inventory, suppliers, POs | | Waste log | Waste log | | ✓ | |
| Menu, modifiers, prices | | | | | Sold out only | ✓ |
| Staff, rota, timesheets | Own | Own | Own | Own | ✓ | ✓ |
| Reports | | | | Own shift | ✓ | ✓ |
| Settings, audit log | | | | | | ✓ |

---

## 8. Roadmap (phases)

Each phase ends with:
- working screens;
- updated tests;
- a short demo checklist.

The app keeps working after every phase.

| Phase | Content | Size |
| --- | --- | --- |
| **0. Local database** | Section 2: replica set, auth, migrate data, remove Docker, `npm run setup` | Small |
| **1. Foundations** | Settings module (tables, tax, hours, receipt); live updates (SSE); new frontend app shell + design system; remove 3D scene, OIDC, signing keys, risk page; MFA policy + PIN switch | Large |
| **2. Sell** | New POS screen; categories and item options; order types (dine-in, takeaway, delivery); hold/void/transfer; kitchen & bar stations | Large |
| **3. Pay** | Split bill, mixed payments, tips, service charge; shifts and cash drawer, Z-report; receipt and kitchen ticket print layouts | Medium |
| **4. Stock** | Suppliers, purchase orders, receiving with cost, stocktake, waste log, unit conversions, recipe cost and margin | Medium |
| **5. Guests** | Customers and loyalty, vouchers/promo codes; floor-plan editor, time-slot reservations, waitlist; feedback | Medium |
| **6. Online** | New public website; online takeaway/delivery ordering with order status; QR table ordering | Medium |
| **7. People** | Clock in/out, timesheets, rota, leave, hours export, tips share | Medium |
| **8. Insight** | New dashboard, daily close, profit, product mix, staff and labour reports, PDF/CSV export | Medium |
| **9. Polish** | Accessibility pass, dark mode, installable app (PWA), performance, final docs and demo data | Small |

The suggested order is 0 → 1 → 2 → 3 first: that gives a modern POS that can take orders and payments end to end. Phases 4–8 can then go in any order.

---

## 9. Quality and testing

- Keep the current test style (node:test + supertest + in-memory MongoDB); every new route gets tests for:
  - success;
  - bad input;
  - wrong role;
  - concurrency where it matters (stock, payments, shifts, loyalty points).
- Keep a guard on every route, and the test that fails if any route has none.
- Money and stock changes run in transactions, with their audit entry in the same transaction.
- Browser tests (Playwright) for the main flows: order → kitchen → pay → report.
- Seed script with a realistic demo cafe: about 40 menu items with options, 20 ingredients, 3 suppliers, 6 staff and a week of orders, so reports look real.

---

## 10. Risks and how to handle them

| Risk | Mitigation |
| --- | --- |
| Changing `mongod.cfg` needs Administrator rights; a typo stops the MongoDB service | Back up the file first; validate the file; keep the Docker data until the move is confirmed |
| The `fraudguard` database is on the same server | Replica set and authentication are server-wide: after turning on authentication, that project also needs a login. Option: leave authentication off locally (only `127.0.0.1` can connect) |
| A full frontend rewrite is large | Do it module by module behind the new shell; old pages stay until their replacement is done |
| Scope creep | Ship the "Must" items of phases 0–3 first; "Could" items only after phase 8 |
| Losing coursework evidence | Keep the security core and the quiz module; move write-ups to `docs/coursework/` |

---

## 11. Decisions needed from you

| # | Decision | Recommended |
| --- | --- | --- |
| 1 | Frontend: rebuild in **React + Vite + Tailwind**, or keep **vanilla JS** with a new design system | React + Vite + Tailwind (faster to build the many new screens, modern look) |
| 2 | Turn on MongoDB **authentication** locally? (affects your `fraudguard` project too) | Yes, with a separate login per project |
| 3 | Authenticator code: required for **all staff**, or **Admin and Manager only** with PINs for the rest | Admin + Manager only, PIN switch for the others |
| 4 | Accent colour: **coffee brown** (#8B5E3C) or **emerald** (#10B981) | Coffee brown |
| 5 | Payments: keep the **simulated** gateway, or add **Stripe test mode** | Simulated for now, Stripe in phase 3 if wanted |
| 6 | One cafe only, or **multiple branches** | One cafe (branches add a lot of complexity) |
