// The rate limiter guarding /api/discount/validate — the only thing standing
// between the discounts table and an enumeration script.
import assert from 'node:assert/strict';
import { createMemoryRateLimiter, createUpstashRateLimiter, createConfiguredRateLimiter } from '../src/lib/rateLimit';

let count = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

await check('allows up to the limit, then blocks', async () => {
  const c = clock();
  const rl = createMemoryRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
  assert.equal(await rl.allow('ip-1'), true);
  assert.equal(await rl.allow('ip-1'), true);
  assert.equal(await rl.allow('ip-1'), true);
  assert.equal(await rl.allow('ip-1'), false);
  assert.equal(await rl.allow('ip-1'), false);
});

await check('keys are independent — one hot IP cannot exhaust another', async () => {
  const c = clock();
  const rl = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  await rl.allow('hot');
  await rl.allow('hot');
  assert.equal(await rl.allow('hot'), false);
  assert.equal(await rl.allow('cold'), true);
});

await check('the window slides: old hits expire, new ones are allowed', async () => {
  const c = clock();
  const rl = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  await rl.allow('ip');
  c.advance(30_000);
  await rl.allow('ip');
  assert.equal(await rl.allow('ip'), false, 'both hits inside the window');
  c.advance(31_000); // first hit is now 61s old
  assert.equal(await rl.allow('ip'), true, 'one slot freed');
  assert.equal(await rl.allow('ip'), false, 'window full again');
});

await check('a blocked attempt does not extend the window (no penalty creep)', async () => {
  const c = clock();
  const rl = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
  await rl.allow('ip');
  for (let i = 0; i < 10; i++) {
    c.advance(1_000);
    assert.equal(await rl.allow('ip'), false);
  }
  c.advance(50_000); // 60s after the ONE allowed hit
  assert.equal(await rl.allow('ip'), true);
});

await check('key-space pruning does not disturb an active key', async () => {
  const c = clock();
  const rl = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  await rl.allow('active');
  await rl.allow('active');
  // Blow past the prune threshold with one-shot keys, then let them expire.
  for (let i = 0; i < 10_100; i++) await rl.allow(`burst-${i}`);
  c.advance(61_000);
  await rl.allow('sweep-trigger'); // sweep happens on this call
  assert.equal(await rl.allow('active'), true, 'active key got its window back');
  assert.equal(await rl.allow('active'), true);
  assert.equal(await rl.allow('active'), false, 'and its limit still applies');
});

// --- The Upstash adapter: pinned by what it SENDS (unverified live) ---------

function fakeUpstash(counts: Record<string, number>) {
  const calls: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const req = init as { headers: Record<string, string>; body: string };
    const body = JSON.parse(req.body) as [string, string][];
    calls.push({ url: String(url), auth: req.headers['Authorization'], body });
    const key = body[0]![1]!;
    counts[key] = (counts[key] ?? 0) + 1;
    return new Response(JSON.stringify([{ result: counts[key] }, { result: 1 }]), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

await check('upstash: sends the documented pipeline — INCR then PEXPIRE NX, bearer auth', async () => {
  const c = clock(120_000); // window index 2 at 60s windows
  const { calls, fetchImpl } = fakeUpstash({});
  const rl = createUpstashRateLimiter({
    limit: 3, windowMs: 60_000, now: c.now,
    url: 'https://example.upstash.io/', token: 'tok-1', fetchImpl,
  });
  assert.equal(await rl.allow('1.2.3.4'), true);
  assert.equal(calls[0]!.url, 'https://example.upstash.io/pipeline');
  assert.equal(calls[0]!.auth, 'Bearer tok-1');
  assert.deepEqual(calls[0]!.body, [
    ['INCR', 'rl:1.2.3.4:2'],
    ['PEXPIRE', 'rl:1.2.3.4:2', '60000', 'NX'],
  ]);
});

await check('upstash: allows up to the limit, then blocks — counter is the shared truth', async () => {
  const c = clock(0);
  const { fetchImpl } = fakeUpstash({});
  const rl = createUpstashRateLimiter({
    limit: 2, windowMs: 60_000, now: c.now,
    url: 'https://example.upstash.io', token: 't', fetchImpl,
  });
  assert.equal(await rl.allow('ip'), true);
  assert.equal(await rl.allow('ip'), true);
  assert.equal(await rl.allow('ip'), false);
});

await check('upstash: a new window index resets the counter key', async () => {
  const c = clock(0);
  const counts: Record<string, number> = {};
  const { fetchImpl } = fakeUpstash(counts);
  const rl = createUpstashRateLimiter({
    limit: 1, windowMs: 60_000, now: c.now,
    url: 'https://example.upstash.io', token: 't', fetchImpl,
  });
  await rl.allow('ip');
  assert.equal(await rl.allow('ip'), false);
  c.advance(60_000); // next fixed window
  assert.equal(await rl.allow('ip'), true, 'fresh window, fresh key');
  assert.ok('rl:ip:0' in counts && 'rl:ip:1' in counts, 'distinct per-window keys');
});

await check('upstash: transport failure fails OPEN — a Redis blip must not block customers', async () => {
  const failing = (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
  const rl = createUpstashRateLimiter({
    limit: 1, windowMs: 60_000,
    url: 'https://example.upstash.io', token: 't', fetchImpl: failing,
  });
  assert.equal(await rl.allow('ip'), true);
  assert.equal(await rl.allow('ip'), true, 'still open while Upstash is down');
});

await check('factory: memory without env, upstash with both vars set', async () => {
  const mem = createConfiguredRateLimiter({ limit: 1, windowMs: 60_000 }, {});
  assert.equal(await mem.allow('x'), true);
  assert.equal(await mem.allow('x'), false, 'behaves like the memory limiter');

  const { calls, fetchImpl } = fakeUpstash({});
  void fetchImpl; // the factory builds its own fetch; presence of calls proves selection instead:
  const up = createConfiguredRateLimiter(
    { limit: 1, windowMs: 60_000 },
    { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' },
  );
  // Real fetch against example.upstash.io will fail -> fail-open TRUE both
  // times, which distinguishes it from the memory limiter's second-call FALSE.
  assert.equal(await up.allow('x'), true);
  assert.equal(await up.allow('x'), true, 'fail-open proves the Upstash path was selected');
  assert.equal(calls.length, 0);
});

console.log(`\n${count} assertions passed.`);
