// Admin order presentation: every fulfilment state maps to a label an
// operator can act on, retry availability agrees with the retry guard, and
// deliberate states never read as generic failures.
import assert from 'node:assert/strict';
import { describeFulfilment } from '../src/lib/admin/orders';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

check('accepted shows the provider order id and offers no retry — nothing ships twice', () => {
  const f = describeFulfilment({
    status: 'paid',
    fulfilment_status: 'accepted',
    provider_response: { provider: 'printify', providerOrderId: '987654' },
  });
  assert.equal(f.tone, 'ok');
  assert.match(f.detail!, /printify order 987654/);
  assert.equal(f.canRetry, false);
});

check('paid + unsubmitted is "awaiting provider" with a next step, not an error', () => {
  const f = describeFulfilment({
    status: 'paid',
    fulfilment_status: 'unsubmitted',
    provider_response: null,
  });
  assert.equal(f.tone, 'warn');
  assert.equal(f.label, 'Awaiting provider');
  assert.match(f.detail!, /API token/);
  assert.equal(f.canRetry, true, 'the retry guard permits paid+unsubmitted');
});

check('pending + unsubmitted is just "awaiting payment" — nothing is wrong', () => {
  const f = describeFulfilment({
    status: 'pending',
    fulfilment_status: 'unsubmitted',
    provider_response: null,
  });
  assert.equal(f.tone, 'muted');
  assert.equal(f.canRetry, false, 'retrying an unpaid order would ship it for free');
});

check('a held order names its stage and carries the recorded reason', () => {
  const f = describeFulfilment({
    status: 'paid',
    fulfilment_status: 'error',
    provider_response: {
      stage: 'print-generation',
      error: 'This photo is too small to print sharply at this size.',
    },
  });
  assert.equal(f.tone, 'error');
  assert.equal(f.label, 'Held: print-generation');
  assert.match(f.detail!, /too small to print/);
  assert.equal(f.canRetry, true);
});

check('an all-providers-failed hold lists every provider and reason', () => {
  const f = describeFulfilment({
    status: 'paid',
    fulfilment_status: 'error',
    provider_response: {
      stage: 'provider-submission',
      failures: [
        { provider: 'printify', error: 'shop suspended' },
        { provider: 'gelato', error: 'timeout' },
      ],
    },
  });
  assert.match(f.detail!, /printify: shop suspended/);
  assert.match(f.detail!, /gelato: timeout/);
});

check('an in-flight submission offers no retry — no racing', () => {
  const f = describeFulfilment({
    status: 'paid',
    fulfilment_status: 'submitting',
    provider_response: null,
  });
  assert.equal(f.canRetry, false);
});

check('retry availability always agrees with the fulfilment retry guard', () => {
  // The button and the endpoint must never disagree: the endpoint consults
  // canRetry(), and describeFulfilment derives canRetry from the same rule.
  for (const status of ['pending', 'paid', 'refunded', 'expired']) {
    for (const fulfilment of ['unsubmitted', 'submitting', 'accepted', 'error']) {
      const f = describeFulfilment({ status, fulfilment_status: fulfilment, provider_response: null });
      const expected = status === 'paid' && (fulfilment === 'unsubmitted' || fulfilment === 'error');
      assert.equal(f.canRetry, expected, `${status}/${fulfilment}`);
    }
  }
});

console.log(`\n${count} assertions passed.`);
