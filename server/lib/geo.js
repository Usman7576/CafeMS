// Country of an IP address, from the public-domain iptoasn ranges (PDDL 1.0) bundled as a package, so
// nothing is sent to an outside service. Loaded once, then each lookup is a binary search.
const fs = require("fs");
const net = require("net");
const path = require("path");

const DATA = path.join(path.dirname(require.resolve("@ip-location-db/iptoasn-country/package.json")));
let v4 = null;
let v6 = null;

function load(file, parse) {
  // The file is a fixed part of an installed package, never chosen by a request
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const lines = fs.readFileSync(path.join(DATA, file), "utf8").split("\n").filter(Boolean);
  const starts = [];
  const ends = [];
  const countries = [];
  for (const line of lines) {
    const [start, end, country] = line.split(",");
    starts.push(parse(start));
    ends.push(parse(end));
    countries.push(country.trim());
  }
  return { starts, ends, countries };
}

function search(table, value) {
  let low = 0;
  let high = table.starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (value < table.starts[mid]) high = mid - 1;
    else if (value > table.ends[mid]) low = mid + 1;
    else return table.countries[mid];
  }
  return null;
}

function ipv4Number(ip) {
  return ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

function ipv6Number(ip) {
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return groups.reduce((total, group) => (total << 16n) + BigInt(parseInt(group || "0", 16)), 0n);
}

// A two-letter country code, or null for private, local or unknown addresses
function countryOf(ip) {
  const text = String(ip || "").replace(/^::ffff:/i, "");
  if (net.isIPv4(text)) {
    if (!v4) v4 = load("iptoasn-country-ipv4-num.csv", Number);
    return search(v4, ipv4Number(text));
  }
  if (net.isIPv6(text) && !text.includes(".")) {
    if (!v6) v6 = load("iptoasn-country-ipv6-num.csv", BigInt);
    return search(v6, ipv6Number(text));
  }
  return null;
}

module.exports = { countryOf };
