// Strict request schemas. Unknown fields and wrong types are refused, which also blocks NoSQL
// operator injection. A message beginning with "!" is safe to show to the user.
const { z } = require("zod");
const { isRealDate } = require("./domain");

const text = (max, message) => z.string().trim().max(max, message);
const noControl = (value) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
const phoneDigits = (value) => value.replace(/[\s-]/g, "");
const mobile = z.string().max(20).transform(phoneDigits).pipe(z.string().regex(/^03\d{9}$/, "!Enter the mobile number as 03XXXXXXXXX."));

// A calendar date that really exists, so 2026-02-30 or 2026-99-99 is refused
const isoDate = (message) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, message).refine(isRealDate, message);
// Whether the table exists is checked against the current settings when the order is placed
const tableNo = z.number().int().min(1, "!Choose a valid table.").max(999, "!Choose a valid table.");
// A chosen option names its group and choice; the server looks up the price, never the browser
const chosen = z.object({
  group: text(24, "!Choose a valid option.").min(1, "!Choose a valid option."),
  choice: text(24, "!Choose a valid option.").min(1, "!Choose a valid option.")
}).strict();
const line = z.object({
  id: z.number().int().min(1),
  qty: z.number().int().min(1, "!Quantity must be at least 1.").max(99, "!Quantity cannot be more than 99."),
  options: z.array(chosen).max(20, "!Too many options on one item.").optional().default([])
}).strict();
const ORDER_TYPES = ["dine-in", "takeaway", "delivery"];
const customer = z.object({
  name: text(40, "!Customer name must be 2-40 characters.").min(2, "!Customer name must be 2-40 characters.").transform(noControl),
  phone: z.union([z.literal(""), mobile]).optional().default(""),
  address: text(160, "!The address must be 160 characters or fewer.").transform(noControl).optional().default("")
}).strict();
const lines = z.array(line).min(1, "!Add at least one item.").max(50, "!An order can have at most 50 lines.");
const notes = text(120, "!Notes must be 120 characters or fewer.").transform(noControl);

module.exports = {
  params: {
    orderId: z.object({ id: z.string().regex(/^ORD-\d{1,12}$/) }).strict(),
    billNo: z.object({ no: z.string().regex(/^B-\d{1,12}$/) }).strict(),
    reservationId: z.object({ id: z.string().regex(/^R-\d{1,12}$/) }).strict(),
    shiftId: z.object({ id: z.string().regex(/^S-\d{1,12}$/) }).strict(),
    waitId: z.object({ id: z.string().regex(/^WL-\d{1,12}$/) }).strict(),
    customerId: z.object({ id: z.string().regex(/^CU-\d{1,9}$/) }).strict(),
    voucherCode: z.object({ code: z.string().regex(/^[A-Z0-9-]{3,20}$/) }).strict(),
    supplierId: z.object({ id: z.string().regex(/^SUP-\d{1,9}$/) }).strict(),
    purchaseId: z.object({ id: z.string().regex(/^PO-\d{1,12}$/) }).strict(),
    requestId: z.object({ id: z.string().regex(/^SR-\d{1,12}$/) }).strict(),
    numericId: z.object({ id: z.string().regex(/^\d{1,9}$/) }).strict(),
    tableNo: z.object({ no: z.string().regex(/^\d{1,3}$/) }).strict(),
    approvalId: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict(),
    alertId: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict()
  },
  // Dine-in needs a table; takeaway a name; delivery a name, mobile number and address
  placeOrder: z.object({
    type: z.enum(ORDER_TYPES, "!Choose dine-in, takeaway or delivery.").optional().default("dine-in"),
    table: tableNo.optional(),
    customer: customer.optional(),
    lines,
    notes: notes.optional().default(""),
    hold: z.boolean().optional().default(false)
  }).strict().superRefine((o, ctx) => {
    const fail = (message, path) => ctx.addIssue({ code: "custom", message, path: [path] });
    if (o.type === "dine-in" && o.table === undefined) fail("!Choose a table.", "table");
    if (o.type !== "dine-in" && o.table !== undefined) fail("!Only dine-in orders have a table.", "table");
    if (o.type !== "dine-in" && !o.customer) fail("!Enter the customer's name.", "customer");
    if (o.type === "delivery" && o.customer && (!o.customer.phone || o.customer.address.length < 5)) fail("!A delivery needs a mobile number and an address.", "customer");
  }),
  transferOrder: z.object({ table: tableNo }).strict(),
  voidOrder: z.object({ reason: text(80, "!Give a reason of 4-80 characters.").min(4, "!Give a reason of 4-80 characters.").transform(noControl) }).strict(),
  updateOrder: z.object({ version: z.number().int().min(0), lines, notes: notes.optional().default("") }).strict(),
  kitchenStatus: z.object({ status: z.enum(["Preparing", "Ready"]) }).strict(),
  pay: z.object({
    discountPct: z.number().int().min(0).max(100).optional().default(0),
    method: z.enum(["Cash", "Card", "Wallet", "Points"], "!Choose a payment method."),
    tendered: z.number().int().min(0).max(100000000).optional(),
    phone: z.union([z.literal(""), mobile]).optional().default(""),
    // A loyalty member found by their number earns points on this payment, or pays with points
    customerId: z.string().regex(/^CU-\d{1,9}$/).optional(),
    voucher: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, "!Enter a valid voucher code.").optional(),
    // Part of the check, for a split bill or a mixed payment; the rest by default
    amount: z.number("!Enter the amount to pay now.").int("!Enter a whole number of rupees.").min(1, "!Enter the amount to pay now.").max(100000000).optional(),
    tip: z.number("!A tip must be a whole number of rupees.").int("!A tip must be a whole number of rupees.").min(0, "!A tip cannot be negative.").max(100000, "!A tip can be at most Rs 100,000.").optional().default(0)
  }).strict(),
  customer: z.object({
    name: text(60, "!The name must be 2-60 characters.").min(2, "!The name must be 2-60 characters.").transform(noControl),
    phone: mobile
  }).strict(),
  customerLookup: z.object({ phone: mobile }).strict(),
  // An order from the website or a table's QR code. A filled-in hidden field marks a bot.
  guestOrder: z.object({
    type: z.enum(["takeaway", "delivery"], "!Choose takeaway or delivery.").optional().default("takeaway"),
    tableCode: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/).optional(),
    customer: z.object({
      name: text(40, "!Your name must be 40 characters or fewer.").transform(noControl).optional().default(""),
      phone: z.union([z.literal(""), mobile]).optional().default(""),
      address: text(160, "!The address must be 160 characters or fewer.").transform(noControl).optional().default("")
    }).strict(),
    lines: z.array(line).min(1, "!Add at least one item.").max(30, "!An online order can have at most 30 lines."),
    notes: notes.optional().default(""),
    website: z.string().max(200).optional().default("")
  }).strict().superRefine((o, ctx) => {
    const fail = (message) => ctx.addIssue({ code: "custom", message, path: ["customer"] });
    if (o.tableCode) return;
    if (o.customer.name.length < 2) fail("!Please enter your name.");
    if (!o.customer.phone) fail("!Please enter your mobile number, so we can reach you about the order.");
    if (o.type === "delivery" && o.customer.address.length < 5) fail("!Please enter the delivery address.");
  }),
  declineOrder: z.object({ reason: text(80, "!Give a reason of 4-80 characters.").min(4, "!Give a reason of 4-80 characters.").transform(noControl) }).strict(),
  trackToken: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{24,64}$/) }).strict(),
  tableCode: z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/) }).strict(),
  voucher: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,20}$/, "!A code is 3-20 letters, numbers or dashes."),
    kind: z.enum(["percent", "amount"], "!Choose percent or amount."),
    value: z.number("!Enter the discount.").int("!Enter a whole number.").min(1, "!Enter the discount.").max(100000),
    minSpend: z.number().int().min(0).max(1000000).optional().default(0),
    expiresOn: z.union([z.literal(""), isoDate("!Choose a valid expiry date.")]).optional().default(""),
    maxUses: z.number().int().min(1).max(100000).optional(),
    active: z.boolean().optional().default(true)
  }).strict().refine((v) => v.kind !== "percent" || v.value <= 100, { message: "!A percent voucher can be at most 100%.", path: ["value"] }),
  voucherActive: z.object({ active: z.boolean() }).strict(),
  waitlistEntry: z.object({
    name: text(40, "!The name must be 2-40 characters.").min(2, "!The name must be 2-40 characters.").transform(noControl),
    party: z.number().int().min(1, "!Party size is 1 to 20.").max(20, "!Party size is 1 to 20."),
    phone: z.union([z.literal(""), mobile]).optional().default(""),
    quotedMinutes: z.number().int().min(0).max(240).optional().default(15)
  }).strict(),
  waitlistSeat: z.object({ table: z.number().int().min(1).max(999).optional() }).strict(),
  feedback: z.object({
    rating: z.number("!Choose 1 to 5 stars.").int("!Choose 1 to 5 stars.").min(1, "!Choose 1 to 5 stars.").max(5, "!Choose 1 to 5 stars."),
    comment: text(300, "!Comments must be 300 characters or fewer.").transform(noControl).optional().default(""),
    name: text(40, "!Your name must be 40 characters or fewer.").transform(noControl).optional().default(""),
    bill: z.union([z.literal(""), z.string().trim().toUpperCase().regex(/^B-\d{1,12}$/, "!Enter the receipt number as it is printed, like B-5001.")]).optional().default(""),
    website: z.string().max(200).optional().default("")
  }).strict(),
  availabilityQuery: z.object({
    date: isoDate("!Choose a valid date."),
    party: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(20))
  }).strict(),
  openShift: z.object({ float: z.number("!Enter the cash in the drawer.").int("!Enter a whole number of rupees.").min(0, "!The float cannot be negative.").max(10000000, "!That float is too large.") }).strict(),
  cashMovement: z.object({
    type: z.enum(["in", "out"], "!Choose cash in or cash out."),
    amount: z.number("!Enter an amount.").int("!Enter a whole number of rupees.").min(1, "!Enter an amount.").max(10000000, "!That amount is too large."),
    reason: text(60, "!Give a reason of 3-60 characters.").min(3, "!Give a reason of 3-60 characters.").transform(noControl)
  }).strict(),
  closeShift: z.object({
    counted: z.number("!Enter the cash you counted.").int("!Enter a whole number of rupees.").min(0, "!The count cannot be negative.").max(10000000, "!That count is too large."),
    note: text(120, "!The note must be 120 characters or fewer.").transform(noControl).optional().default("")
  }).strict(),
  shiftQuery: z.object({ date: isoDate().optional() }).strict(),
  retryPayment: z.object({
    method: z.enum(["Cash", "Card", "Wallet"]).optional(),
    tendered: z.number().int().min(0).max(100000000).optional()
  }).strict(),
  gatewayCallback: z.object({
    reference: z.string().regex(/^B-\d{1,12}$/),
    amount: z.number().int().min(0).max(100000000),
    status: z.enum(["approved", "declined"]),
    gatewayRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
  }).strict(),
  eraseCustomer: z.object({ phone: mobile }).strict(),
  refund: z.object({ reason: text(80, "!Give a reason of 4-80 characters.").min(4, "!Give a reason of 4-80 characters.").transform(noControl) }).strict(),
  menuItem: z.object({
    name: text(40, "!Item name must be 2-40 characters.").min(2, "!Item name must be 2-40 characters.").transform(noControl),
    cat: text(24, "!Choose or enter a category.").min(1, "!Choose or enter a category.").transform(noControl),
    price: z.number("!Price must be a whole number between Rs 50 and Rs 20,000.").int("!Price must be a whole number between Rs 50 and Rs 20,000.").min(50, "!Price must be a whole number between Rs 50 and Rs 20,000.").max(20000, "!Price must be a whole number between Rs 50 and Rs 20,000."),
    desc: text(80, "!Description must be 80 characters or fewer.").transform(noControl).optional().default(""),
    available: z.boolean().optional().default(true),
    recipe: z.array(z.object({
      ing: z.number().int().min(1),
      qty: z.number("!Enter how much of each ingredient one portion uses.").positive("!Enter how much of each ingredient one portion uses.").max(1000, "!Enter how much of each ingredient one portion uses.")
    }).strict()).max(20, "!A recipe can have at most 20 ingredients.").optional(),
    // Option groups such as Size or Milk. A choice may add to the price.
    options: z.array(z.object({
      name: text(24, "!An option group name must be 1-24 characters.").min(1, "!An option group name must be 1-24 characters.").transform(noControl),
      required: z.boolean(),
      multi: z.boolean(),
      choices: z.array(z.object({
        name: text(24, "!A choice name must be 1-24 characters.").min(1, "!A choice name must be 1-24 characters.").transform(noControl),
        price: z.number("!An extra price must be a whole number from 0 to Rs 5,000.").int("!An extra price must be a whole number from 0 to Rs 5,000.").min(0, "!An extra price must be a whole number from 0 to Rs 5,000.").max(5000, "!An extra price must be a whole number from 0 to Rs 5,000.")
      }).strict()).min(1, "!Each option group needs at least one choice.").max(10, "!An option group can have at most 10 choices.")
    }).strict()).max(5, "!An item can have at most 5 option groups.").optional()
  }).strict(),
  supplier: z.object({
    name: text(60, "!The supplier name must be 2-60 characters.").min(2, "!The supplier name must be 2-60 characters.").transform(noControl),
    phone: text(20, "!The phone number must be 20 characters or fewer.").regex(/^[0-9+\-\s]*$/, "!The phone number can use only digits, spaces, + and -.").optional().default(""),
    email: z.union([z.literal(""), z.string().trim().max(100).email("!Enter a valid email address.")]).optional().default(""),
    notes: text(200, "!Notes must be 200 characters or fewer.").transform(noControl).optional().default(""),
    active: z.boolean().optional().default(true)
  }).strict(),
  ingredient: z.object({
    name: text(40, "!The name must be 2-40 characters.").min(2, "!The name must be 2-40 characters.").transform(noControl),
    unit: z.enum(["kg", "g", "L", "ml", "pcs"], "!Choose a unit."),
    reorder: z.number("!Enter a reorder level.").min(0, "!The reorder level cannot be negative.").max(100000),
    cost: z.number("!Enter the cost per unit.").min(0, "!The cost cannot be negative.").max(1000000, "!That cost is too large."),
    supplierId: z.union([z.literal(""), z.string().regex(/^SUP-\d{1,9}$/)]).optional().default("")
  }).strict(),
  ingredientDetails: z.object({
    reorder: z.number("!Enter a reorder level.").min(0, "!The reorder level cannot be negative.").max(100000),
    cost: z.number("!Enter the cost per unit.").min(0, "!The cost cannot be negative.").max(1000000, "!That cost is too large."),
    supplierId: z.union([z.literal(""), z.string().regex(/^SUP-\d{1,9}$/)]).optional().default("")
  }).strict(),
  purchaseOrder: z.object({
    supplierId: z.string().regex(/^SUP-\d{1,9}$/, "!Choose a supplier."),
    lines: z.array(z.object({
      ing: z.number().int().min(1),
      packs: z.number("!Enter how many packs.").int("!Packs must be a whole number.").min(1, "!Order at least one pack.").max(10000),
      packSize: z.number("!Enter the pack size.").positive("!Enter the pack size.").max(10000),
      packCost: z.number("!Enter the price per pack.").min(0, "!The price cannot be negative.").max(10000000)
    }).strict()).min(1, "!Add at least one item.").max(50, "!An order can have at most 50 lines."),
    notes: text(200, "!Notes must be 200 characters or fewer.").transform(noControl).optional().default("")
  }).strict(),
  receiveOrder: z.object({
    lines: z.array(z.object({
      ing: z.number().int().min(1),
      packs: z.number("!Enter how many packs arrived.").int().min(0, "!Packs cannot be negative.").max(10000),
      packCost: z.number().min(0).max(10000000).optional()
    }).strict()).max(50).optional().default([])
  }).strict(),
  stocktake: z.object({
    counts: z.array(z.object({ ing: z.number().int().min(1), counted: z.number("!Enter what you counted.").min(0, "!A count cannot be negative.").max(1000000) }).strict()).min(1, "!Count at least one item.").max(500),
    note: text(120, "!The note must be 120 characters or fewer.").transform(noControl).optional().default("")
  }).strict(),
  waste: z.object({
    ing: z.number().int().min(1, "!Choose what was wasted."),
    qty: z.number("!Enter how much was wasted.").positive("!Enter how much was wasted.").max(1000, "!Enter how much was wasted."),
    reason: text(60, "!Give a reason of 3-60 characters.").min(3, "!Give a reason of 3-60 characters.").transform(noControl)
  }).strict(),
  stockAdjustment: z.object({
    delta: z.number("!Enter a quantity between 0 and 1000.").finite().min(-1000, "!Enter a quantity between 0 and 1000.").max(1000, "!Enter a quantity between 0 and 1000.").refine((n) => n !== 0, "!Enter a quantity between 0 and 1000."),
    reason: text(60, "!Add a short reason of up to 60 characters.").min(1, "!Add a short reason of up to 60 characters.").transform(noControl)
  }).strict(),
  reservation: z.object({
    name: text(60, "!Guest name must be 2-60 characters.").min(2, "!Guest name must be 2-60 characters.").transform(noControl),
    phone: mobile,
    date: isoDate("!Choose a valid reservation date."),
    time: z.string().regex(/^\d{2}:\d{2}$/, "!Choose a valid reservation time."),
    party: z.number("!Party size must be a whole number from 1 to 20.").int("!Party size must be a whole number from 1 to 20.").min(1, "!Party size must be a whole number from 1 to 20.").max(20, "!Party size must be a whole number from 1 to 20."),
    notes: text(160, "!Notes must be 160 characters or fewer.").transform(noControl).optional().default("")
  }).strict(),
  publicReservation: z.object({
    name: text(60, "!Please enter your name (2-60 characters).").min(2, "!Please enter your name (2-60 characters).").transform(noControl),
    phone: mobile,
    date: isoDate("!Please choose a date."),
    time: z.string().regex(/^\d{2}:\d{2}$/, "!Please choose a time."),
    party: z.number("!Guests must be a whole number from 1 to 20.").int("!Guests must be a whole number from 1 to 20.").min(1, "!Guests must be a whole number from 1 to 20.").max(20, "!Guests must be a whole number from 1 to 20."),
    notes: text(160, "!Notes must be 160 characters or fewer.").transform(noControl).optional().default(""),
    website: z.string().max(200).optional().default("")
  }).strict(),
  reservationStatus: z.object({ status: z.enum(["Requested", "Confirmed", "Seated", "Completed", "Cancelled"]), table: z.number().int().min(1).max(999).optional() }).strict(),
  reservationSearch: z.object({ phone: mobile }).strict(),
  reservationQuery: z.object({
    date: isoDate().optional(),
    status: z.enum(["Requested", "Confirmed", "Seated", "Completed", "Cancelled"]).optional()
  }).strict(),
  salesQuery: z.object({ date: isoDate().optional() }).strict(),
  // Angle brackets are refused, so a note can never carry markup into the audit log
  auditReview: z.object({ note: z.string().trim().min(3).max(200).regex(/^[^<>]*$/) }).strict(),
  auditQuery: z.object({
    severity: z.enum(["info", "warning", "high"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
    before: z.iso.datetime().optional()
  }).strict(),
  userRole: z.object({ role: z.enum(["Waiter", "Barista", "Kitchen", "Cashier", "Manager", "Admin"]) }).strict(),
  userStatus: z.object({ status: z.enum(["Active", "Disabled"]) }).strict(),
  // Staff requests (quiz Q2/Q3). Strict: owner, status, version and timestamps come only from the server,
  // so a request that tries to set them is refused rather than trusted.
  staffRequest: z.object({
    title: z.string("!Enter a title.").transform((v) => v.normalize("NFKC").replace(/\s+/g, " ").trim())
      .pipe(z.string().min(5, "!The title must be at least 5 characters after removing extra spaces.").max(100, "!The title can be at most 100 characters.").regex(/^[^<>]*$/, "!The title cannot contain < or >.")),
    description: z.string("!Enter a description.").transform((v) => v.normalize("NFKC").trim())
      .pipe(z.string().min(15, "!The description must be at least 15 characters.").max(1000, "!The description can be at most 1000 characters.")),
    category: z.enum(["Equipment", "Supplies", "Maintenance", "Staffing", "Other"], "!Choose a category from the list."),
    contactPhone: z.union([z.literal(""), mobile]).optional().default("")
  }).strict(),
  requestQuery: z.object({
    search: z.string().trim().max(100, "!Search text can be at most 100 characters.").optional().default(""),
    category: z.enum(["Equipment", "Supplies", "Maintenance", "Staffing", "Other"], "!Unknown category filter.").optional(),
    status: z.enum(["Pending", "In Review", "Resolved", "Rejected"], "!Unknown status filter.").optional(),
    sort: z.enum(["newest", "oldest"], "!Sort must be newest or oldest.").optional().default("newest"),
    page: z.string().regex(/^[1-9]\d{0,3}$/, "!Page must be a whole number from 1 to 9999.").optional().default("1").transform(Number)
  }).strict(),
  requestTransition: z.object({ version: z.number("!The record version is missing.").int().min(1) }).strict(),
  requestReject: z.object({
    version: z.number("!The record version is missing.").int().min(1),
    reason: z.string("!Give a reason for the rejection.").trim().min(1, "!Give a reason for the rejection.").max(300, "!The reason can be at most 300 characters.").regex(/^[^<>]*$/, "!The reason cannot contain < or >.")
  }).strict(),
  // Public staff registration. No role field: the Admin chooses it when approving.
  registration: z.object({
    name: text(60, "!Enter your full name (2-60 characters).").min(2, "!Enter your full name (2-60 characters).").regex(/^[^<>]*$/, "!Enter your full name (2-60 characters).").transform(noControl),
    username: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9._]{2,29}$/, "!Username must be 3-30 letters, numbers, dots or underscores, starting with a letter."),
    password: z.string().min(1, "!Choose a password.").max(128, "!Passwords can be at most 128 characters."),
    website: z.string().max(200).optional().default("")
  }).strict(),
  cafeDetails: z.object({
    name: text(40, "!The cafe name must be 2-40 characters.").min(2, "!The cafe name must be 2-40 characters.").transform(noControl),
    tagline: text(80, "!The tagline must be 80 characters or fewer.").transform(noControl),
    about: text(300, "!The description must be 300 characters or fewer.").transform(noControl),
    address: text(120, "!The address must be 120 characters or fewer.").transform(noControl),
    phone: text(20, "!The phone number must be 20 characters or fewer.").regex(/^[0-9+\-\s]*$/, "!The phone number can use only digits, spaces, + and -.").transform(noControl),
    hours: text(80, "!Opening hours must be 80 characters or fewer.").transform(noControl)
  }).strict(),
  // Operating settings. Every part is required, so a save always describes the whole cafe.
  operations: z.object({
    version: z.number().int().min(0),
    taxRatePct: z.number().min(0, "!Tax must be between 0 and 30%.").max(30, "!Tax must be between 0 and 30%.").multipleOf(0.5, "!Tax can use steps of 0.5%."),
    tables: z.array(z.object({
      no: z.number().int().min(1, "!Table numbers run from 1 to 999.").max(999, "!Table numbers run from 1 to 999."),
      seats: z.number().int().min(1, "!A table seats 1 to 20 people.").max(20, "!A table seats 1 to 20 people."),
      area: text(30, "!An area name must be 30 characters or fewer.").min(1, "!Give each table an area.").transform(noControl),
      x: z.number().int().min(0).max(11).optional(),
      y: z.number().int().min(0).max(7).optional(),
      shape: z.enum(["square", "round", "long"]).optional()
    }).strict()).min(1, "!The cafe needs at least one table.").max(100, "!Up to 100 tables are supported."),
    discountLimits: z.object({
      Cashier: z.number().int().min(0, "!Discount limits run from 0 to 100%.").max(100, "!Discount limits run from 0 to 100%."),
      Manager: z.number().int().min(0, "!Discount limits run from 0 to 100%.").max(100, "!Discount limits run from 0 to 100%.")
    }).strict(),
    receipt: z.object({
      header: text(80, "!The receipt header must be 80 characters or fewer.").transform(noControl),
      footer: text(120, "!The receipt footer must be 120 characters or fewer.").transform(noControl)
    }).strict(),
    categories: z.array(z.object({
      name: text(24, "!A category name must be 1-24 characters.").min(1, "!A category name must be 1-24 characters.").transform(noControl),
      station: z.enum(["Kitchen", "Bar"], "!Choose Kitchen or Bar for each category.")
    }).strict()).min(1, "!Keep at least one category.").max(30, "!Up to 30 categories are supported."),
    orderTypes: z.object({ dineIn: z.boolean(), takeaway: z.boolean(), delivery: z.boolean() }).strict(),
    serviceChargePct: z.number().min(0, "!The service charge must be between 0 and 20%.").max(20, "!The service charge must be between 0 and 20%.").multipleOf(0.5, "!The service charge can use steps of 0.5%.").optional().default(0),
    requireShift: z.boolean().optional().default(false),
    loyalty: z.object({
      enabled: z.boolean(),
      earnPer100: z.number().int("!Points per Rs 100 must be a whole number.").min(0).max(20, "!Points per Rs 100 can be at most 20."),
      pointValue: z.number().min(0.1, "!A point must be worth Rs 0.10 to Rs 10.").max(10, "!A point must be worth Rs 0.10 to Rs 10.")
    }).strict().optional(),
    online: z.object({ ordering: z.boolean(), qr: z.boolean() }).strict().optional(),
    bookings: z.object({
      open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "!Enter the opening time as HH:MM."),
      close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "!Enter the closing time as HH:MM."),
      slotMinutes: z.number().int().refine((n) => [15, 30, 60].includes(n), "!Booking times can be every 15, 30 or 60 minutes."),
      durationMinutes: z.number().int().min(30, "!A booking holds a table for 30 to 240 minutes.").max(240, "!A booking holds a table for 30 to 240 minutes.")
    }).strict().optional()
  }).strict()
};
