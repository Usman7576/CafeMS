// The server's single source of truth for who may do what. Anything not listed is denied.
const ROLES = Object.freeze(["Waiter", "Kitchen", "Cashier", "Manager", "Admin"]);

const PERMISSIONS = Object.freeze({
  "orders.write": ["Waiter"],
  "kitchen.read": ["Kitchen"],
  "kitchen.update": ["Kitchen"],
  "billing.pay": ["Cashier", "Manager"],
  "billing.refund": ["Manager"],
  "billing.approveRefund": ["Manager", "Admin"],
  "customer.phone": ["Manager", "Admin"],
  "reservations.write": ["Waiter", "Manager"],
  "inventory.write": ["Manager"],
  "reports.read": ["Manager", "Admin"],
  "menu.write": ["Admin"],
  "users.manage": ["Admin"],
  "audit.read": ["Admin"],
  "risk.read": ["Admin"]
});

// Protected pages: checked on the server before the HTML is sent.
const PAGES = Object.freeze({
  "/dashboard.html": ["Waiter"],
  "/order.html": ["Waiter"],
  "/reservation.html": ["Waiter", "Manager"],
  "/reservations.html": ["Waiter", "Manager"],
  "/kitchen.html": ["Kitchen"],
  "/billing.html": ["Cashier", "Manager"],
  "/overview.html": ["Manager", "Admin"],
  "/inventory.html": ["Manager"],
  "/reports.html": ["Manager", "Admin"],
  "/menu.html": ["Admin"],
  "/users.html": ["Admin"],
  "/audit.html": ["Admin"]
});

const PUBLIC_PAGES = Object.freeze(["/", "/index.html", "/login.html", "/setup.html", "/404.html"]);

const HOME = Object.freeze({
  Waiter: "/dashboard.html",
  Kitchen: "/kitchen.html",
  Cashier: "/billing.html",
  Manager: "/overview.html",
  Admin: "/overview.html"
});

function can(role, permission) {
  return Object.hasOwn(PERMISSIONS, permission) && PERMISSIONS[permission].includes(role);
}

module.exports = { ROLES, PERMISSIONS, PAGES, PUBLIC_PAGES, HOME, can };
