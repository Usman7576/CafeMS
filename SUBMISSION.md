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
The other four roles (Kitchen, Cashier, Manager, Admin) also have working workspaces, so the whole flow can be demonstrated.

## 2. Live Website

**Public URL:** _[paste hosted URL]_

**Demo sign-in:** username `m.usman` (Waiter) with any password that has 8+ characters, upper and lower case letters and a number. The other demo accounts are listed on the sign-in page.

## 3. Developed Pages

The three required pages:

1. **Home / Landing** (`index.html`): system name, purpose, problem & solution, 9 core modules, roles, security requirements, demo accounts, navigation, footer.
2. **Staff Sign-in** (`login.html`): username + password, validation, show/hide password, Caps Lock warning, lockout, password-reset guidance.
3. **Core functional pages for the Waiter:** **Dashboard** (`dashboard.html`) and **Take / Edit Order** (`order.html`).

Additional role workspaces: Kitchen display, Billing, Overview, Inventory, Sales reports, Menu management, Staff & roles, Audit log, and a custom 404 page.

Flow: Home → Sign in → role workspace (Waiter: Dashboard ⇄ Take order) → Sign out.

## 4. JavaScript Interactions

1. **Form validation**: sign-in validation, live password checklist; validated forms for menu items, staff, stock and refunds.
2. **Show/hide password** with a Caps Lock warning.
3. **Search & filtering**: menu search and category tabs; order, stock, bill, staff and audit filters.
4. **Add/remove items (dynamic list)**: order ticket with +/− steppers and live totals; edit an order before the kitchen starts it.
5. **Modals & confirmation messages**: order confirmation, receipts, refund, role change, confirm dialogs, toasts.
6. **Character counter** on kitchen notes and item descriptions.
7. **Live status tracking** across roles: Placed → Preparing → Ready → Served → Paid, with notifications.
8. **Navigation interactions**: role-based sidebar, Ctrl+K command palette, notification panel, mobile menu.
9. **Session handling**: role guard on every page, idle sign-out with warning, lockout after 5 failed sign-ins.
10. **Charts and exports**: revenue by hour, payment donut, best sellers; CSV export and printable receipts.

## 5. Testing

**Problem discovered:** _[record the problem your group member found while using the site without explanation]_

Issues we found and fixed during our own testing:
- A sign-in form submitted before its script loaded would have sent the password in the URL. Fixed: POST-only form, and the button stays disabled until the script is ready.
- On phones the dashboard scrolled sideways. Fixed: layouts can shrink, tables scroll inside their panels, and less important columns are hidden.
- The "Send to kitchen" button was disabled with no explanation. Fixed: a visible hint.
- The kitchen simulation moved tickets on before the kitchen user could act. Fixed: it pauses while the kitchen display is open.
- The receipt printed a stray "null" line and was taller than the screen. Fixed.

**Improvement made:** _[how you fixed the group member's problem]_
