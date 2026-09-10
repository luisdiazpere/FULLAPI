/**
 * ponytail: in-memory, per-instance — fine for the single free-tier instance
 * this runs on. Swap for a shared store (Redis, etc.) if this ever scales to
 * more than one instance.
 */
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function allow(key: string, now = Date.now()): boolean {
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}
