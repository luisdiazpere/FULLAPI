/**
 * ponytail: in-memory, per-instance — fine for the single free-tier instance
 * this runs on. Swap for a shared store (Redis, etc.) if this ever scales to
 * more than one instance.
 */
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  function allow(key: string, now = Date.now()): boolean {
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      // Sweep before inserting a new key. Without this the map only overwrites keys
      // that come back, so every distinct key is retained for the process lifetime —
      // unbounded growth fed by unauthenticated traffic, and newly reachable now that
      // trustProxy makes req.ip distinct per client. Runs only on the new-key branch,
      // so a caller inside its window never pays for it.
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  // The bound is the point of the sweep and is invisible from outside; expose the
  // count so it cannot regress silently.
  allow.tracked = (): number => hits.size;

  return allow;
}
