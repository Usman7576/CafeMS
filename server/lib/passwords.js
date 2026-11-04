const argon2 = require("argon2");

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

const COMMON = new Set([
  "password1234", "password12345", "passw0rd1234", "p@ssw0rd1234", "p@ssword1234", "qwerty123456", "qwertyuiop12",
  "123456789012", "administrator", "admin1234567", "letmein12345", "welcome12345", "iloveyou1234", "cafems123456",
  "changeme1234", "pakistan1234", "football1234", "baseball1234", "abc123456789", "1q2w3e4r5t6y"
]);

// A fixed hash verified for unknown accounts, so response time does not reveal which usernames exist.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await argon2.hash("cafems-account-does-not-exist", OPTIONS);
  await argon2.verify(dummyHash, String(password));
  return false;
}

function hashPassword(password) {
  return argon2.hash(password, OPTIONS);
}

async function verifyPassword(hash, password) {
  if (!hash) return dummyVerify(password);
  return argon2.verify(hash, String(password));
}

// Returns a list of unmet rules; an empty list means the password is acceptable.
function passwordProblems(password, username) {
  const value = String(password);
  const problems = [];
  if (value.length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters.`);
  if (value.length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters.`);
  if (!/[a-z]/.test(value)) problems.push("Add a lowercase letter.");
  if (!/[A-Z]/.test(value)) problems.push("Add an uppercase letter.");
  if (!/[0-9]/.test(value)) problems.push("Add a number.");
  if (!/[^A-Za-z0-9]/.test(value)) problems.push("Add a symbol.");
  const lower = value.toLowerCase();
  if (username && lower.includes(String(username).toLowerCase())) problems.push("Do not include your username.");
  if (COMMON.has(lower)) problems.push("This password is too common.");
  return problems;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblems, MAX_LENGTH };
