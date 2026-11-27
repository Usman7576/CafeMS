# CafeMS user guide

A short how-to for each role. Each person sees only the screens their role allows; after signing in, CafeMS opens their own home screen.

| Role | Home screen | Also uses |
| --- | --- | --- |
| Waiter | Floor (dashboard) | POS, Reservations, Team, Requests |
| Barista | Bar display | Team, Requests |
| Kitchen | Kitchen display | Team, Requests |
| Cashier | Billing | POS (counter orders), Team, Requests |
| Manager | Overview | Billing, Stock, Guests, Insights, Reports, Reservations, Team |
| Admin | Overview | Menu, Staff, Settings, Guests, Insights, Reports, Audit log, Security |

## Getting started

- **First sign-in.** Use the username and password you were given. Managers and Admins then add an authenticator app (scan the QR code) and type its 6-digit code at each sign-in.
- **Tablet PIN.** Waiters, Baristas, Kitchen staff and Cashiers can set a 4–6 digit PIN on **Account**. On a shared tablet, open the account menu and choose **Switch user** to swap to yourself with your PIN.
- **Theme.** The account menu has **Theme**: *as device* (follows the tablet or phone), *light* or *dark*. The choice is remembered on that device.
- **Install the app.** In Chrome or Edge, choose *Install CafeMS* from the address bar (on iPad: Share → *Add to Home Screen*). It opens full screen like an app. It still needs the cafe's network: nothing private is kept on the device.
- **Signing out.** Sessions end after 5 minutes without use, or 8 hours in all. Sign out from the account menu when you leave a shared device.

## Waiter

1. **Take an order.** Open **POS**, choose *Dine-in* and a table (or *Takeaway* / *Delivery* with the guest's name), tap items, pick any options, then **Send**. **Hold** keeps the order without sending it to the kitchen.
2. **Follow it.** The floor shows each table's orders. When the kitchen and bar mark everything *Ready*, serve it and mark it *Served*.
3. **Move or ask for the bill.** Move an order to another table, or press **Request bill** so the cashier sees it.
4. **Guests.** Look up or enrol a loyalty member by phone. Manage bookings and the walk-in waitlist on **Reservations**, using the floor plan.
5. **Guest orders.** Orders from the website or a table's QR code wait under **Incoming**: accept them (they go to the kitchen) or decline them with a reason.

## Kitchen and Barista

- The display shows only your station's part of each order: food for Kitchen, drinks for the Bar. No prices or guest details are shown.
- Tap an order to move it from *Placed* to *Preparing* to *Ready*. The screen updates live; oldest orders come first.
- Log anything spoiled or dropped with **Waste**, so stock and profit stay right.

## Cashier

1. **Open a shift** with the cash in the drawer before taking payments.
2. **Take payment.** Choose a table or counter order on **Billing**. Add a discount (up to your limit), a voucher code or loyalty points, then pay by cash, card or wallet. Split the bill evenly, by items or by amount, and take part-payments in different methods.
3. **Tips** are added at payment and shared among the staff on shift by hours worked.
4. **Print** the receipt (80 mm) or a kitchen ticket.
5. **Close the shift**: count the drawer. The Z-report shows the expected cash and any difference.

## Manager

- **Overview** shows today's sales, open orders, tables and alerts as they happen.
- **Voids and refunds** ask for a fresh authenticator code. Large refunds need a second person to approve.
- **Stock:** suppliers, purchase orders (bought in packs, received with their cost), stocktakes and the waste log. Low stock appears in alerts.
- **Guests:** loyalty members, vouchers and guest ratings.
- **Team:** plan the rota, approve leave, correct timesheets, export hours as CSV, see the tips share.
- **Insights:** sales, busiest hours, product mix and margin, profit after ingredients, waste and staff pay, staff performance and the printable daily close. Each table downloads as CSV.

## Admin

- **Menu:** items, photos, options and recipes. Each item shows its ingredient cost and margin.
- **Staff:** add people, change roles, reset passwords, disable accounts. Changes to Admin accounts need a second Admin.
- **Settings:** cafe details, tax and service charge, discount limits, receipt text, tables and floor plan, categories and their station, order types, and booking hours and time slots.
- **Audit log** records every important action in a tamper-evident chain. **Security** shows alerts and the security checks.

## Demo data

To show the system with a realistic week of trade, run:

```powershell
npm run demo
```

It adds the past 7 days of paid bills (using your own menu and staff), clock-ins, this week's rota, a few guest ratings, a `DEMO10` voucher and starting pay rates. It does not change stock or write audit entries, and it will not run in production. Remove it all again with:

```powershell
npm run demo -- --remove
```
