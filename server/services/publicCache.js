// A short-lived cache for what the public website reads (cafe details and the menu). Anyone on the
// internet can ask for these, so without a cache a flood of requests becomes a flood of database
// queries that slows the staff screens. Any successful staff change clears it at once, so the site
// never shows an Admin's edit late; stock-driven "sold out" labels can lag by up to ttlMs.
function createPublicCache({ ttlMs = 5000 } = {}) {
  const entries = new Map();
  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      const value = load();
      entries.set(key, { value, expires: Date.now() + ttlMs });
      // A failed load is not kept, so the next request tries again
      value.catch(() => entries.delete(key));
      return value;
    },
    clear() {
      entries.clear();
    }
  };
}

module.exports = { createPublicCache };
