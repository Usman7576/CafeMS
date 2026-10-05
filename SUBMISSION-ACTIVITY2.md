# Development Activity 2: Role-Based Functional Prototype

Same project as Activity 1: **Cafe Management System (CMS)**. It runs offline with plain HTML, CSS and JavaScript. Open `index.html`, or serve the folder locally.

## Part 1: Selected roles

- **Role 1:** Cashier
- **Role 2:** Manager

These two roles do different jobs. The cashier takes payments at the counter. The manager runs the café and approves sensitive actions such as refunds.

## Part 2: Role functions

| Role | Functions |
|---|---|
| **Cashier** | 1. Bill an open table (items, 16% GST, total)<br>2. Apply a discount of up to **10%**<br>3. Take payment by cash (with change calculator), card or mobile wallet, and print the receipt<br>4. View today's bills and reprint receipts |
| **Manager** | 1. View the overview dashboard: revenue by hour, live floor, stock alerts, activity<br>2. **Issue refunds** with a recorded reason<br>3. Manage inventory: restock and write off stock<br>4. View sales reports and export them to CSV<br>5. Approve discounts up to **25%** |

## Part 3: Demo users

The demo users are in `js/store.js` (`seed()` → `users`):

| Name | Username | Role |
|---|---|---|
| Bilal Ahmed | `bilal.ahmed` | Cashier |
| Sara Khan | `sara.khan` | Manager |

Password: in this prototype the **username identifies the demo user**, and any password that passes the password policy is accepted (8+ characters, upper and lower case letters and a number, for example `Testpass123`). Real password checking (hashed with bcrypt/Argon2) is planned for the server. Unknown or disabled usernames are refused with a generic "Incorrect username or password" message. No database is needed. Data is kept in the browser's `localStorage`.

## Part 4: Functional login

`login.html` with `js/login.js` works like this:

Login → validate input → **identify user** (`Store.findUser`) → check the account is active → **identify role** → save the session (`sessionStorage`) → **redirect to that role's home page**:

- Cashier → `billing.html`
- Manager → `overview.html`

## Part 5: Role-specific dashboards

| Cashier workspace | Manager workspace |
|---|---|
| "Good afternoon, Bilal" (greeting + name in top bar) | "Good afternoon, Sara" (greeting + name in top bar) |
| [Billing: open tables] | [Overview] |
| [Bill & take payment] | [Billing] |
| [Today's bills / Receipts] | [Inventory] |
| [Sign out] | [Sales reports & refunds] |
| | [Sign out] |

The greeting changes with the time of day (morning/afternoon/evening). The sidebar navigation is built from the role (`NAV` in `js/app.js`). Each role also gets an "access" note in the sidebar that says what it may do.

## Part 6: Testing the role difference

| Test | Expected result | Actual |
|---|---|---|
| Cashier logs in | Goes to **Billing**, and the sidebar shows only *Billing* | ✅ Pass |
| Manager logs in | Goes to **Overview**, and the sidebar shows *Overview, Billing, Inventory, Sales reports* | ✅ Pass |
| Cashier views dashboard | Discount buttons above 10% are disabled, and customer phone numbers are masked | ✅ Pass |
| Manager views dashboard | KPIs, revenue chart and stock alerts are shown. Discounts up to 25% are allowed and phone numbers are shown in full | ✅ Pass |

## Part 7: Protected function

- **Function selected:** Issue a refund on a paid bill
- **Authorized role:** Manager (Admin also has it as the owner)

How it works:

```
IF user's role = Manager
    open the refund form (reason required) → bill marked Refunded
ELSE
    show "Access denied", record the attempt in the audit log
END IF
```

The check is made in two places:

1. **UI** (`js/billing.js`, `requestRefund`): a cashier who clicks **Refund** sees an *Access denied* dialog.
2. **Data layer** (`js/store.js`, `refund`): this check runs again however the function is called. It refuses the request, writes an `Access denied` audit entry and leaves the bill unchanged. In the final system this becomes the server-side check in the REST API.

Typing the URL of another role's page, such as `inventory.html` as a cashier, is blocked too. The user is redirected home with "You don't have permission to open that page", and the attempt is logged.

## Part 8: Security-aware data display

- **Selected information:** customer mobile number. It is optional and collected at billing so the customer can get an e-receipt.
- **Who can see it:** Manager (and Admin) see it **in full**, for example to contact a customer about a refund. A **Cashier** sees it **masked**: `0300-•••••43`.

Masking happens in the data layer (`forViewer` in `js/store.js`), so the cashier's page never receives the full number. The receipt and the *Today's bills* table both show the masked value. The number is validated as `03XXXXXXXXX` before it is saved.

## Part 9: Logout

**Sign out** is in the sidebar and the user menu. It asks for confirmation, then:

- writes a "Signed out" audit entry
- clears the session (`sessionStorage`)
- returns the user to `login.html`. Pressing **Back** does not reopen the dashboard: the page guard sees there is no session and sends the user to the login page again

Opening any protected page after logout sends the user back to the login page. The app also signs a user out automatically after 5 minutes of inactivity.

## Part 10: Prototype tests

| Test | Result |
|---|---|
| **Test 1: correct role.** Log in as `bilal.ahmed` | Billing workspace opened with Cashier navigation only. Customer phone numbers shown masked (`0345-•••••34`). ✅ |
| **Test 2: different role.** Log out, log in as `sara.khan` | Overview workspace opened with the Manager menu. On Billing, the same bills show full numbers (`03451122334`). ✅ |
| **Test 3: restricted function.** Cashier clicks *Refund* on bill B-5011 | An *Access denied* dialog: "Only a manager can issue refunds. Your attempt on B-5011 has been recorded in the audit log." Bill stays **Paid**. Audit log entry: *Access denied: Tried to refund B-5011 (refunds are manager-only)*, severity high. ✅ |
| **Test 4: logout.** Click *Sign out*, then press Back or open `billing.html` | Returned to the login page with "You have been signed out." Session is empty. Back and `billing.html` both redirect to login. ✅ |

## Part 11: Security development note

- **Security concept applied:** Role-Based Access Control (RBAC) with **least privilege**. Data minimisation (masking personal data) and audit logging support it.
- **Where it was applied:** the login and session (`js/login.js`, `js/common.js`), the page guard and role menus (`js/app.js`), the billing page (`js/billing.js`), and the data layer (`js/store.js`: `refund`, `pay`, `bills`/`forViewer`).
- **What was changed:** the login routes each user to their role's dashboard. Each role sees only its own menu and pages. A refund now checks the role in both the UI and the data layer. Customer phone numbers are masked for cashiers. Denied attempts are written to the audit log. Logout clears the session.
- **What happens when an unauthorized role tries the restricted operation:** the cashier sees an *Access denied* message. Nothing changes: the bill stays Paid and revenue is untouched. The attempt is recorded in the audit log with the user, role, bill number and time, where the Admin can review it.

---

## Submission

| | |
|---|---|
| **Project Name** | Cafe Management System (CMS) |
| **Group Members** | M. Usman (22L-7991), _[member]_, _[member]_, _[member]_ |
| **Live/Local Project** | _[public URL]_ (local: open `index.html`) |
| **Roles Implemented** | Cashier and Manager (Waiter, Kitchen and Admin also work) |
| **Restricted Function** | Issue refund (Manager only) |
| **Security Concept Applied** | RBAC / least privilege, plus masking of customer phone numbers and audit logging of denied actions |
