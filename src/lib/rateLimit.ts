// Sliding-window rate limiter, in memory.
//
// KNOWN GAP (see CLAUDE.md): in-memory means per-instance. The moment this
// app runs in more than one region/instance, the effective limit multiplies
// silently. The fix is Upstash (or any shared store) behind this same
// interface — callers don't change.

export interface RateLimiter {
  allow(key: string): boolean;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  // Injectable clock so tests can move time instead of sleeping.
  now?: () => number;
}

// Stop unbounded growth from unique keys (an attacker rotating IPs would
// otherwise grow the map forever). Past this many keys, dead entries are
// swept on the next call.
const PRUNE_THRESHOLD = 10_000;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    allow(key: string): boolean {
      const t = now();
      const cutoff = t - opts.windowMs;

      if (hits.size > PRUNE_THRESHOLD) {
        for (const [k, stamps] of hits) {
          if (stamps.every((s) => s <= cutoff)) hits.delete(k);
        }
      }

      const recent = (hits.get(key) ?? []).filter((s) => s > cutoff);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
  };
}
