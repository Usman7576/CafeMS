// Strict request schemas. Unknown fields and wrong types are refused, which also blocks NoSQL
// operator injection. A message beginning with "!" is safe to show to the user.
const { z } = require("zod");
const { TABLE_NUMBERS } = require("./domain");

const text = (max, message) => z.string().trim().max(max, message);
const noControl = (value) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
const phoneDigits = (value) => value.replace(/[\s-]/g, "");
const mobile = z.string().max(20).transform(phoneDigits).pipe(z.string().regex(/^03\d{9}$/, "!Enter the mobile number as 03XXXXXXXXX."));

const tableNo = z.number().int().refine((n) => TABLE_NUMBERS.includes(n), "!Choose a valid table.");
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
    available: z.boolean().optional().default(true)
  }).strict(),
  stockAdjustment: z.object({
    delta: z.number("!Enter a quantity between 0 and 1000.").finite().min(-1000, "!Enter a quantity between 0 and 1000.").max(1000, "!Enter a quantity between 0 and 1000.").refine((n) => n !== 0, "!Enter a quantity between 0 and 1000."),
    reason: text(60, "!Add a short reason of up to 60 characters.").min(1, "!Add a short reason of up to 60 characters.").transform(noControl)
  }).strict(),
  reservation: z.object({
    name: text(60, "!Guest name must be 2-60 characters.").min(2, "!Guest name must be 2-60 characters.").transform(noControl),
    phone: mobile,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "!Choose a valid reservation date."),
    time: z.string().regex(/^\d{2}:\d{2}$/, "!Choose a valid reservation time."),
    party: z.number("!Party size must be a whole number from 1 to 20.").int("!Party size must be a whole number from 1 to 20.").min(1, "!Party size must be a whole number from 1 to 20.").max(20, "!Party size must be a whole number from 1 to 20."),
    notes: text(160, "!Notes must be 160 characters or fewer.").transform(noControl).optional().default("")
  }).strict(),
  reservationStatus: z.object({ status: z.enum(["Confirmed", "Seated", "Completed", "Cancelled"]) }).strict(),
  reservationQuery: z.object({
    phone: mobile.optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z.enum(["Confirmed", "Seated", "Completed", "Cancelled"]).optional()
  }).strict(),
  salesQuery: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  auditQuery: z.object({
    severity: z.enum(["info", "warning", "high"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
    before: z.iso.datetime().optional()
  }).strict(),
  userRole: z.object({ role: z.enum(["Waiter", "Kitchen", "Cashier", "Manager", "Admin"]) }).strict(),
  userStatus: z.object({ status: z.enum(["Active", "Disabled"]) }).strict(),
  settings: z.object({ kitchenSim: z.boolean() }).strict()
};
