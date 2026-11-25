// The server's single source of truth for who may do what. Anything not listed is denied.
const ROLES = Object.freeze(["Waiter", "Barista", "Kitchen", "Cashier", "Manager", "Admin"]);

const PERMISSIONS = Object.freeze({
  "menu.read": ["Waiter", "Cashier", "Admin"],
  // Counter sales: a cashier can take takeaway and delivery orders as well as bill them
  "orders.write": ["Waiter", "Cashier"],
  // Each station works its own part of an order: Kitchen the food, Barista the bar
  "kitchen.read": ["Kitchen", "Barista"],
  "kitchen.update": ["Kitchen", "Barista"],
  // A sent order can be voided only by a manager, after a fresh authenticator code
  "orders.void": ["Manager"],
  // Each cashier runs their own shift and cash drawer; a manager sees every shift's Z-report
  "shifts.own": ["Cashier", "Manager"],
  "shifts.all": ["Manager", "Admin"],
  "billing.pay": ["Cashier", "Manager"],
  "billing.read": ["Cashier", "Manager", "Admin"],
  "billing.refund": ["Manager"],
  "billing.approveRefund": ["Manager", "Admin"],
  "approvals.read": ["Manager", "Admin"],
  "customer.phone": ["Manager", "Admin"],
  "customer.erase": ["Admin"],
  "reservations.write": ["Waiter", "Manager"],
  "inventory.read": ["Manager", "Admin"],
  "inventory.write": ["Manager"],
  // Spoiled or dropped stock is logged by whoever threw it away
  "waste.write": ["Kitchen", "Barista", "Manager"],
  // Guests: look up and enrol loyalty members where the guest is; managers see the list and vouchers
  "customers.lookup": ["Waiter", "Cashier", "Manager", "Admin"],
  "customers.enrol": ["Waiter", "Cashier", "Manager"],
  "customers.read": ["Manager", "Admin"],
  "vouchers.manage": ["Manager", "Admin"],
  "waitlist.write": ["Waiter", "Cashier", "Manager"],
  "feedback.read": ["Manager", "Admin"],
  "reports.read": ["Manager", "Admin"],
  "menu.write": ["Admin"],
  "users.manage": ["Admin"],
  "settings.write": ["Admin"],
  "audit.read": ["Admin"],
  "alerts.manage": ["Admin"],
  // Staff requests: Role 1 (submitters) own their requests; Role 2 (Manager) reviews them
  "requests.read": ["Waiter", "Barista", "Kitchen", "Cashier", "Manager"],
  "requests.submit": ["Waiter", "Barista", "Kitchen", "Cashier"],
  "requests.review": ["Manager"]
});

// Protected pages: checked on the server before the HTML is sent.
const PAGES = Object.freeze({
  "/dashboard.html": ["Waiter"],
  "/order.html": ["Waiter", "Cashier"],
  "/reservation.html": ["Waiter", "Manager"],
  "/reservations.html": ["Waiter", "Manager"],
  "/kitchen.html": ["Kitchen", "Barista"],
  "/billing.html": ["Cashier", "Manager"],
  "/overview.html": ["Manager", "Admin"],
  "/inventory.html": ["Manager"],
  "/reports.html": ["Manager", "Admin"],
  "/menu.html": ["Admin"],
  "/users.html": ["Admin"],
  "/settings.html": ["Admin"],
  "/guests.html": ["Manager", "Admin"],
  "/audit.html": ["Admin"],
  "/security.html": ["Admin"],
  "/requests.html": ["Waiter", "Barista", "Kitchen", "Cashier", "Manager"],
  "/account.html": ["Waiter", "Barista", "Kitchen", "Cashier", "Manager", "Admin"]
});

const PUBLIC_PAGES = Object.freeze(["/", "/index.html", "/login.html", "/register.html", "/setup.html", "/privacy.html", "/404.html", "/order-online.html", "/track.html"]);

const HOME = Object.freeze({
  Waiter: "/dashboard.html",
  Barista: "/kitchen.html",
  Kitchen: "/kitchen.html",
  Cashier: "/billing.html",
  Manager: "/overview.html",
  Admin: "/overview.html"
});

// Admins and Managers hold the keys to money and accounts, so they must use an authenticator.
// The roles that share tablets on the floor may switch to themselves with a PIN instead.
const MFA_ROLES = Object.freeze(["Manager", "Admin"]);
const PIN_ROLES = Object.freeze(["Waiter", "Barista", "Kitchen", "Cashier"]);
// The station each display role works
const STATION_OF = Object.freeze({ Kitchen: "Kitchen", Barista: "Bar" });
const mfaRequired = (role) => MFA_ROLES.includes(role);

function can(role, permission) {
  return Object.hasOwn(PERMISSIONS, permission) && PERMISSIONS[permission].includes(role);
}

module.exports = { ROLES, PERMISSIONS, PAGES, PUBLIC_PAGES, HOME, MFA_ROLES, PIN_ROLES, STATION_OF, mfaRequired, can };
