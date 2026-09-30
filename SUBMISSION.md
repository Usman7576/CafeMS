# Development Activity 1 — Submission

## 1. Project Information

**Project Name:** BrewDesk – Cafe Management System (CMS)

**Group Members:**
| No. | Name | Roll No. | Role |
|---|---|---|---|
| 1 | M. Usman | 22L-7991 | Team Lead |
| 2 | _[Member name]_ | _[Roll no.]_ | Backend |
| 3 | _[Member name]_ | _[Roll no.]_ | Frontend |
| 4 | _[Member name]_ | _[Roll no.]_ | Security / Testing |

**Primary User Role:** Waiter — takes orders at tables and views table status.

## 2. Live Website

**Public URL:** _[paste your GitHub Pages / Netlify URL here]_

## 3. Developed Pages

1. **Home / Landing page** (`index.html`) — system name, purpose, problem it solves, core modules, user roles, security overview, navigation, CTA buttons, footer.
2. **Staff Login page** (`login.html`) — username + password only (no role selector: the role is assigned by the admin and decided by the server), show/hide password, validation, lockout after 5 failed attempts.
3. **Take Order page** (`order.html`, core module for the Waiter) — select a table, search/filter the menu, add/remove items, live subtotal/tax/total, kitchen notes, confirm and send to kitchen, list of orders sent this shift, log out.

Flow: **Home → Staff Login → Take Order → Log out → Login**

## 4. JavaScript Interactions

1. **Login form validation + show/hide password** — username format and password strength checked with inline errors; after 5 failed attempts the form locks for 30 seconds (mirrors SR-1 / SR-6).
2. **Menu search and category filter** — live search box plus category chips (Coffee, Cold Drinks, Tea, Food, Desserts); sold-out items are disabled.
3. **Dynamic order list with add/remove items** — +/− quantity controls, live totals with 16% tax, send button enabled only when a table and at least one item are chosen.
4. **Confirmation modal** — shows table, items, total and notes before sending to the kitchen; success toast afterwards.
5. **Character counter** on kitchen notes (120 max).
6. **Session handling** — order page redirects to login if not signed in; auto sign-out after 5 minutes idle; mobile hamburger navigation.

### Security-aware design choices
- Login asks only for username + password; password field is masked, never stored, and the page tells users not to use a real password on the prototype.
- No role dropdown on login, and the waiter screen shows no admin functions (prices, refunds, reports, user management).
- No customer phone numbers, emails or payment details are collected or shown on the waiter screen.
- User-entered text (kitchen notes) is rendered with `textContent`, not `innerHTML`, so HTML/script input shows as plain text (tested with `<img src=x onerror=alert(1)>`).
- Generic login error message; lockout after repeated failures; idle timeout.
- Hiding admin features is *not* a security control — real RBAC, hashing and session checks will be enforced on the backend later.

## 5. Testing

**Problem discovered:** _[Replace with what your group member found when testing without explanation.]_
Example found during our own testing: on the Take Order page, the "Send to kitchen" button stayed greyed out and the tester didn't know why. The reason was only in a hover tooltip, which doesn't show on phones.

**Improvement made:** Added a visible hint under the button that says "Select a table first." or "Add at least one item." and disappears once the order is ready to send.
