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
const line = z.object({
  id: z.number().int().min(1),
  qty: z.number().int().min(1, "!Quantity must be at least 1.").max(99, "!Quantity cannot be more than 99.")
}).strict();
const lines = z.array(line).min(1, "!Add at least one item.").max(50, "!An order can have at most 50 lines.");
const notes = text(120, "!Notes must be 120 characters or fewer.").transform(noControl);

module.exports = {
  params: {
    orderId: z.object({ id: z.string().regex(/^ORD-\d{1,12}$/) }).strict(),
    billNo: z.object({ no: z.string().regex(/^B-\d{1,12}$/) }).strict(),
    reservationId: z.object({ id: z.string().regex(/^R-\d{1,12}$/) }).strict(),
    requestId: z.object({ id: z.string().regex(/^SR-\d{1,12}$/) }).strict(),
    numericId: z.object({ id: z.string().regex(/^\d{1,9}$/) }).strict(),
    tableNo: z.object({ no: z.string().regex(/^\d{1,3}$/) }).strict(),
    approvalId: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict(),
    alertId: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }).strict()
  },
  placeOrder: z.object({ table: tableNo, lines, notes: notes.optional().default("") }).strict(),
  updateOrder: z.object({ version: z.number().int().min(0), lines, notes: notes.optional().default("") }).strict(),
  kitchenStatus: z.object({ status: z.enum(["Preparing", "Ready"]) }).strict(),
  pay: z.object({
    discountPct: z.number().int().min(0).max(100).optional().default(0),
    method: z.enum(["Cash", "Card", "Wallet"], "!Choose a payment method."),
    tendered: z.number().int().min(0).max(100000000).optional(),
    phone: z.union([z.literal(""), mobile]).optional().default("")
  }).strict(),
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
    }).strict()).max(20, "!A recipe can have at most 20 ingredients.").optional()
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
  reservationStatus: z.object({ status: z.enum(["Requested", "Confirmed", "Seated", "Completed", "Cancelled"]) }).strict(),
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
  userRole: z.object({ role: z.enum(["Waiter", "Kitchen", "Cashier", "Manager", "Admin"]) }).strict(),
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
      area: text(30, "!An area name must be 30 characters or fewer.").min(1, "!Give each table an area.").transform(noControl)
    }).strict()).min(1, "!The cafe needs at least one table.").max(100, "!Up to 100 tables are supported."),
    discountLimits: z.object({
      Cashier: z.number().int().min(0, "!Discount limits run from 0 to 100%.").max(100, "!Discount limits run from 0 to 100%."),
      Manager: z.number().int().min(0, "!Discount limits run from 0 to 100%.").max(100, "!Discount limits run from 0 to 100%.")
    }).strict(),
    receipt: z.object({
      header: text(80, "!The receipt header must be 80 characters or fewer.").transform(noControl),
      footer: text(120, "!The receipt footer must be 120 characters or fewer.").transform(noControl)
    }).strict()
  }).strict()
};
