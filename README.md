# Cafe Management System (CMS): MongoDB-backed prototype

A secure, web-based Cafe Management System built as the semester project for **Secure Software Development (SSD)**.
The prototype covers the full service loop across all five staff roles. A waiter takes an order, the kitchen prepares it, the cashier bills it, and it all appears in the manager's reports and the admin's tamper-evident audit log.

> **Live demo:** _add your public URL here_

## Demo accounts

Sign in with any account below and **any password that meets the rules**: 8+ characters, with upper- and lower-case letters and a number. Don't use a real password.

| Role | Username | Lands on |
|---|---|---|
| **Waiter** (primary role) | `m.usman` | Waiter dashboard |
| Kitchen | `chef.imran` | Kitchen display |
| Cashier | `bilal.ahmed` | Billing |
| Manager | `sara.khan` | Overview |
| Admin / Owner | `farah.admin` | Overview |

`old.staff` is a **disabled** account, and sign-in is refused. Unknown usernames get the same generic error, so it never reveals which accounts exist.

Activity write-ups: [SUBMISSION.md](SUBMISSION.md) (Activity 1), [SUBMISSION-ACTIVITY2.md](SUBMISSION-ACTIVITY2.md) (Activity 2: role-based prototype), and [SUBMISSION-ACTIVITY3.md](SUBMISSION-ACTIVITY3.md) (Activity 3: parallel module development and integration).

## Pages

| Page | Roles | What it does |
|---|---|---|
| `index.html` | Public | Landing page: purpose, 9 modules, roles, SR-1 to SR-8, demo accounts |
| `login.html` | Public | Sign-in with validation, show/hide password, Caps Lock warning, rules checklist, lockout |
| `dashboard.html` | Waiter | Shift KPIs, my orders (filters), ready-to-serve queue, floor plan, request bill |
| `order.html` | Waiter | Take or **edit** an order: table picker, menu search/filter, ticket, live totals, notes |
| `kitchen.html` | Kitchen | Live ticket board (New → Preparing → Ready) with colour-coded ticket timers |
| `billing.html` | Cashier, Manager | Open tables, role-limited discounts, cash/card/wallet, change calculator, optional customer mobile (masked for cashiers), printable receipt, manager-only refunds |
| `overview.html` | Manager, Admin | Revenue by hour, live floor, stock alerts, activity feed, admin settings |
| `inventory.html` | Manager | Stock levels, low-stock alerts, restock / write-off with reasons |
| `reports.html` | Manager, Admin | KPIs, hourly revenue, payment split, best sellers, categories, tax summary, refunds, CSV export |
| `menu.html` | Admin | Add / edit / delete items, prices, on/off switch, large-price-change warning |
| `users.html` | Admin | Create staff, change roles, enable/disable accounts, permission matrix |
| `audit.html` | Admin | Hash-chained audit log with integrity check, filters, CSV export |
| `reservation.html` | Waiter, Manager | Create and validate a table reservation |
| `reservations.html` | Waiter, Manager | Search, filter and update reservation status |
| `404.html` | Public | Custom not-found page |

## How the data flows

```
Waiter sends order ──► Kitchen: New → Preparing → Ready ──► Waiter serves ──► Waiter requests bill
      │ stock deducted per recipe                                                   │
      ▼                                                                             ▼
Inventory (low-stock alerts, auto sold-out)            Cashier bills table → receipt → table freed
                                                                                    │
                        Manager reports / refunds  ◄────────────────────────────────┘
                        Admin audit log ◄── every critical action from every role
```

When no kitchen user has the display open, the kitchen is **simulated**: an order moves to Preparing after about 10 s and to Ready about 20 s later. An admin can switch this off. The browser keeps a local cache for offline use, while the Node.js API synchronizes the application state to MongoDB. Use **Reset demo data** in the user menu to start again.

## Security-aware design

| Requirement | In this prototype |
|---|---|
| SR-1 Strong authentication | Username format and password complexity rules; generic failure messages (no account enumeration) |
| SR-3 RBAC / least privilege | Each role gets only its own navigation and pages. Opening another role's page redirects and writes an *Access denied* audit entry. Disabled or re-roled users are signed out on their next page load. Discount limits per role (Cashier 10%, Manager 25%). Refunds are manager-only: a cashier who clicks **Refund** gets *Access denied*, the data layer rejects the request again, and the attempt is audited. Admins can't demote or disable themselves, and at least one admin must always remain. |
| Personal data (least privilege) | Customer mobile numbers are shown in full only to Manager/Admin. Cashiers get a masked value (`0300-•••••43`), and the masking happens in the data layer, so the full number never reaches a cashier's page. |
| SR-4 Input validation / XSS | All data-layer writes are validated. All user text is rendered with `textContent`, never `innerHTML`. CSV exports neutralise spreadsheet formula injection. |
| SR-6 Sessions | Auto sign-out after 5 min idle with a 30 s warning. Sign-in pauses after 5 failures. |
| SR-7 Auditing | Sign-ins, failures, lockouts, access denials, price/menu changes, role and account changes, refunds, discounts, stock changes and exports are logged. Entries are **hash-chained**, so editing or deleting one is detected on the audit page. |
| SR-8 Payment security | Card and wallet payments go through a (simulated) gateway. No card fields exist, and nothing is stored. |
| Credential handling | Password never stored; POST-only form that can't submit before its script loads, so credentials never appear in URLs |

> Hiding a button is **not** a security control. This is a frontend prototype, and everything above will be enforced again on the server: bcrypt/Argon2 hashing, server-side RBAC on every request, parameterised queries, HTTPS and a server-side audit log.

## Tech

Plain HTML5, CSS3 and vanilla JavaScript with no build step and no dependencies. Inter and JetBrains Mono fonts. Inline SVG icons (Lucide-style, MIT). Dependency-free SVG charts.

```
css/style.css        design system and all components
js/icons.js          inline SVG icons
js/common.js         DOM helper, toasts, modals, confirm dialog, charts, CSV export, session
js/store.js          prototype data layer ("fake backend"): users, menu, stock, orders, bills, audit
js/app.js            staff app shell: role guard, sidebar, top bar, notifications, Ctrl+K palette, idle timeout
js/<page>.js         one script per page
```

Keyboard: **Ctrl/⌘ + K** opens quick search on any staff page. **Esc** closes dialogs.

## Run locally with MongoDB

MongoDB Compass is a graphical client; it does not run the MongoDB database server by itself. Install and start MongoDB Community Server, or use a MongoDB Atlas connection string. Then:

```bash
npm install
copy .env.example .env
npm start
```

Open http://localhost:3000. The default connection is `mongodb://127.0.0.1:27017`, database `cafems`. You can verify the connection at http://localhost:3000/api/health and inspect the `application_state` collection in Compass.

For MongoDB Atlas, replace `MONGODB_URI` in `.env` with the connection string from Atlas. Never commit `.env`; it is ignored by git.

To run the UI without MongoDB, use `python -m http.server 8000`; it will use the browser's local cache and will not synchronize to MongoDB.

## Deploy to Netlify

The repository root contains `index.html` and `netlify.toml`, so no build command or framework adapter is required.

1. Push this repository to GitHub, GitLab or Bitbucket.
2. In Netlify, choose **Add new site → Import an existing project** and select the repository.
3. Leave the build command empty. Set the publish directory to `.` if Netlify does not detect it automatically.
4. Deploy the site. Netlify will use the included `netlify.toml` and the custom `404.html` page.

For a manual deploy, drag this repository root (the folder containing `index.html`) onto https://app.netlify.com/drop.

After changing CSS or JS, bump the `?v=` number in the HTML files so browsers load the new files.

## Team

| Name | Roll No. | Role |
|---|---|---|
| M. Usman | 22L-7991 | Team Lead |
| _[Member]_ | _[Roll no.]_ | Backend |
| _[Member]_ | _[Roll no.]_ | Frontend |
| _[Member]_ | _[Roll no.]_ | Security / Testing |
