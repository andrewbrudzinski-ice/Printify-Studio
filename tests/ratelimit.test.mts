// The rate limiter guarding /api/discount/validate — the only thing standing
// between the discounts table and an enumeration script.
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/rateLimit';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

check('allows up to the limit, then blocks', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
  assert.equal(rl.allow('ip-1'), true);
  assert.equal(rl.allow('ip-1'), true);
  assert.equal(rl.allow('ip-1'), true);
  assert.equal(rl.allow('ip-1'), false);
  assert.equal(rl.allow('ip-1'), false);
});

check('keys are independent — one hot IP cannot exhaust another', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  rl.allow('hot');
  rl.allow('hot');
  assert.equal(rl.allow('hot'), false);
  assert.equal(rl.allow('cold'), true);
});

check('the window slides: old hits expire, new ones are allowed', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  rl.allow('ip');
  c.advance(30_000);
  rl.allow('ip');
  assert.equal(rl.allow('ip'), false, 'both hits inside the window');
  c.advance(31_000); // first hit is now 61s old
  assert.equal(rl.allow('ip'), true, 'one slot freed');
  assert.equal(rl.allow('ip'), false, 'window full again');
});

check('a blocked attempt does not extend the window (no penalty creep)', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
  rl.allow('ip');
  for (let i = 0; i < 10; i++) {
    c.advance(1_000);
    assert.equal(rl.allow('ip'), false);
  }
  c.advance(50_000); // 60s after the ONE allowed hit
  assert.equal(rl.allow('ip'), true);
});

check('key-space pruning does not disturb an active key', () => {
  const c = clock();
  const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: c.now });
  rl.allow('active');
  rl.allow('active');
  // Blow past the prune threshold with one-shot keys, then let them expire.
  for (let i = 0; i < 10_100; i++) rl.allow(`burst-${i}`);
  c.advance(61_000);
  rl.allow('sweep-trigger'); // sweep happens on this call
  assert.equal(rl.allow('active'), true, 'active key got its window back');
  assert.equal(rl.allow('active'), true);
  assert.equal(rl.allow('active'), false, 'and its limit still applies');
});

console.log(`\n${count} assertions passed.`);
