const argon2 = require("argon2");

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

const COMMON = new Set([
  "password1234", "password12345", "passw0rd1234", "p@ssw0rd1234", "p@ssword1234", "qwerty123456", "qwertyuiop12",
  "123456789012", "administrator", "admin1234567", "letmein12345", "welcome12345", "iloveyou1234", "cafems123456",
  "changeme1234", "pakistan1234", "football1234", "baseball1234", "abc123456789", "1q2w3e4r5t6y"
]);

// Base words people build passwords from. A password is refused when, after removing the digits and
// symbols around it and undoing common swaps such as @ for a or 0 for o, what is left is one of these.
// This catches "Password123!" and "P@ssw0rd2024", which pass every character-type rule.
const COMMON_WORDS = new Set([
  "password", "passwd", "passw", "pass", "welcome", "admin", "administrator", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl",
  "zxcvbn", "letmein", "iloveyou", "cafems", "cafe", "coffee", "pakistan", "lahore", "karachi", "islamabad", "football",
  "baseball", "cricket", "monkey", "dragon", "master", "sunshine", "princess", "shadow", "superman", "batman", "login",
  "user", "test", "guest", "changeme", "secret", "summer", "winter", "spring", "autumn", "hello", "freedom", "whatever",
  "trustno", "starwars", "abc", "abcd", "abcdef", "manager", "cashier", "waiter", "kitchen", "staff", "default", "root"
]);
const SWAPS = Object.freeze({ "@": "a", "4": "a", "8": "b", "3": "e", "1": "i", "!": "i", "0": "o", "$": "s", "5": "s", "7": "t", "+": "t" });

function guessable(lower) {
  const trimmed = lower.replace(/^[^a-z@$]+/, "").replace(/[^a-z]+$/, "");
  const core = [...trimmed].map((c) => (Object.hasOwn(SWAPS, c) ? SWAPS[c] : c)).join("").replace(/[^a-z]/g, "").replace(/^(.+?)\1+$/, "$1");
  if (!core) return false;
  if (COMMON_WORDS.has(core)) return true;
  // A common word with one or two extra letters, such as "Passwordx1!"
  return [...COMMON_WORDS].some((w) => w.length >= 5 && core.length - w.length <= 2 && (core.startsWith(w) || core.endsWith(w)));
}

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
  if (COMMON.has(lower) || guessable(lower)) problems.push("This password is too common or too easy to guess.");
  return problems;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblems, MAX_LENGTH };
