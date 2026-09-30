# Development Activity 1 — Submission

## 1. Project Information

**Project Name:** Cafe Management System (CMS)

**Group Members:**

| No. | Name | Roll No. | Role |
|---|---|---|---|
| 1 | M. Usman | 22L-7991 | Team Lead |
| 2 | _[Member name]_ | _[Roll no.]_ | Backend |
| 3 | _[Member name]_ | _[Roll no.]_ | Frontend |
| 4 | _[Member name]_ | _[Roll no.]_ | Security / Testing |

**Primary User Role:** Waiter. Takes orders at tables. Permissions: create/update orders, view table status.

## 2. Live Website

**Public URL:** _[paste hosted URL]_

## 3. Developed Pages

1. **Home / Landing** (`index.html`): system name, purpose, problem & solution, 9 core modules, user roles, security requirements, navigation, sign-in buttons, footer.
2. **Staff Sign-in** (`login.html`): username + password, validation, show/hide password, lockout, password-reset guidance.
3. **Waiter Dashboard** (`dashboard.html`, core): shift KPIs, my orders with status filters, ready-to-serve queue, table status map, unavailable items.
4. **Take Order** (`order.html`, core): table picker, menu search & filter, order ticket with live totals, kitchen notes, confirmation.

Flow: Home → Staff sign in → Dashboard ⇄ Take order → Sign out. Plus a custom `404.html`.

## 4. JavaScript Interactions

1. **Form validation**: sign-in validation with inline errors and a live password-rules checklist.
2. **Show/hide password** with a Caps Lock warning.
3. **Search & filtering**: live menu search and category tabs; dashboard order filters (Active / Ready / Served / All).
4. **Add/remove items (dynamic list)**: order ticket with +/− steppers and live subtotal, 16% tax and total.
5. **Modal / confirmation**: order summary before sending to the kitchen; confirm dialogs for cancel, clear and sign out.
6. **Character counter** on kitchen notes (120 max).
7. **Live order status tracking**: Placed → Preparing → Ready → Served, with "ready to serve" alerts, Serve and Cancel actions.
8. **Navigation interaction**: table map opens the order page for a table; mobile sidebar, user menu, notifications.
9. **Session handling**: sign-in required for staff pages, inactivity warning and automatic sign-out after 5 minutes, simulated lockout after 5 failed sign-ins.

## 5. Testing

**Problem discovered:** _[record the problem your group member found while using the site without explanation]_

Issues we found and fixed during our own testing:
- If the sign-in form was submitted before its script finished loading, the browser sent it as a GET request, **putting the password in the URL**. Fixed: the form uses POST, and the Sign in button stays disabled until the script is ready.
- On phones, the dashboard scrolled sideways because the orders table forced the layout wider. Fixed: the table scrolls inside its panel, and less important columns are hidden on small screens.
- The "Send to kitchen" button was greyed out without saying why. Fixed: a visible hint now says "Select a table" or "Add at least one item".

**Improvement made:** _[how you fixed the group member's problem]_
