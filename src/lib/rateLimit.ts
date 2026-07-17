// Rate limiting behind one interface, two implementations:
//
//   createMemoryRateLimiter  — per-instance sliding window. Correct on a
//                              single instance; the limit silently multiplies
//                              across regions/instances.
//   createUpstashRateLimiter — shared fixed-window counter in Upstash Redis
//                              over its REST API (no SDK dependency). Correct
//                              across any number of instances.
//
// createConfiguredRateLimiter picks Upstash when its env vars are present and
// falls back to memory otherwise — so a single-region deploy works with zero
// config and a multi-region deploy is two env vars, no code change.
//
// allow() is async because the shared implementation is a network hop; the
// memory implementation just resolves immediately.

export interface RateLimiter {
  allow(key: string): Promise<boolean>;
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

export function createMemoryRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  return {
    async allow(key: string): Promise<boolean> {
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

export interface UpstashOptions extends RateLimiterOptions {
  url: string; // UPSTASH_REDIS_REST_URL
  token: string; // UPSTASH_REDIS_REST_TOKEN
  fetchImpl?: typeof fetch;
}

// Fixed-window counter: INCR rl:<key>:<windowIndex>, set the TTL on first
// hit, allow while count <= limit. Fixed windows admit at most 2x the limit
// across a boundary — an acceptable trade for one round trip per check on an
// endpoint whose real requirement is "not enumerable", not exact fairness.
//
// UNVERIFIED against live Upstash, same convention as the other adapters:
// written to the documented REST pipeline API; the tests pin exactly what it
// sends. On transport failure it FAILS OPEN with a warning — this limiter
// guards a discount-code preview, and blocking every legitimate customer
// because Redis blipped costs more than briefly admitting an enumerator.
export function createUpstashRateLimiter(opts: UpstashOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async allow(key: string): Promise<boolean> {
      const windowIndex = Math.floor(now() / opts.windowMs);
      const redisKey = `rl:${key}:${windowIndex}`;
      try {
        const res = await doFetch(`${opts.url.replace(/\/$/, '')}/pipeline`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([
            ['INCR', redisKey],
            // PEXPIRE with NX applies only when the key has no TTL yet, so
            // the window expires opts.windowMs after its FIRST hit and later
            // hits can't keep extending it.
            ['PEXPIRE', redisKey, String(opts.windowMs), 'NX'],
          ]),
        });
        if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
        const results = (await res.json()) as Array<{ result?: unknown; error?: string }>;
        const count = results[0]?.result;
        if (typeof count !== 'number') {
          throw new Error(results[0]?.error ?? 'Upstash returned no counter value.');
        }
        return count <= opts.limit;
      } catch (err) {
        console.warn(
          `rate limiter failing open (Upstash unreachable): ${err instanceof Error ? err.message : err}`,
        );
        return true;
      }
    },
  };
}

export function createConfiguredRateLimiter(
  opts: RateLimiterOptions,
  env: Record<string, string | undefined> = process.env,
): RateLimiter {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createUpstashRateLimiter({ ...opts, url, token });
  }
  return createMemoryRateLimiter(opts);
}
