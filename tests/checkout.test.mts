// The server-side checkout recompute and the webhook state machine. The
// builder is where "the client never sends a price" becomes enforceable;
// the webhook is where "a replayed Stripe delivery is provably a no-op" does.
import assert from 'node:assert/strict';
import {
  buildCheckoutOrder,
  isCheckoutValidationError,
  type CheckoutItemInput,
  type VariantRow,
} from '../src/lib/checkout/session';
import { applyStripeEvent, type WebhookDb, type WebhookOrder } from '../src/lib/checkout/webhook';
import { priceCart } from '../src/lib/pricing/engine';
import { shippingFor } from '../src/lib/pricing/shipping';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import { applyPatch } from '../src/stores/editor';

let count = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    count += 1;
    console.log(`  ok  ${label}`);
  });
}

// --- Fixtures -------------------------------------------------------------------

function variant(sku: string, over: Partial<VariantRow> = {}): [string, VariantRow] {
  return [
    sku,
    {
      variantId: `var-${sku}`,
      templateId: 'tpl-mug',
      templateSlug: 'mug',
      templateName: 'Mug',
      variantName: sku,
      price: 1499,
      variantActive: true,
      templateActive: true,
      ...over,
    },
  ];
}

const VARIANTS = new Map<string, VariantRow>([
  variant('MUG-11-WHT'),
  variant('MUG-15-WHT', { price: 1799 }),
  variant('TEE-BLK-M', {
    templateId: 'tpl-tee',
    templateSlug: 'tshirt',
    templateName: 'T-Shirt',
    price: 2199,
  }),
  variant('OLD-SKU', { variantActive: false }),
]);

function item(over: Partial<CheckoutItemInput> = {}): CheckoutItemInput {
  return {
    templateSlug: 'mug',
    variantSku: 'MUG-11-WHT',
    quantity: 1,
    spec: structuredClone(DEFAULT_SPEC),
    designId: 'design-1',
    ...over,
  };
}

function build(items: CheckoutItemInput[], over: Record<string, unknown> = {}) {
  return buildCheckoutOrder({
    items,
    variantsBySku: VARIANTS,
    bundles: [],
    discount: null,
    shippingZoneId: 'domestic',
    ...over,
  });
}

// --- The recompute ----------------------------------------------------------------

await check('totals come from database prices — client-side numbers do not exist here', () => {
  // The payload type has no price field at all; smuggling one in changes
  // nothing because the builder only reads the variant map.
  const smuggled = { ...item(), unitPrice: 1, price: 1, total: 1 } as CheckoutItemInput;
  const built = build([smuggled, item({ variantSku: 'MUG-15-WHT', designId: 'design-2', quantity: 2 })]);
  assert.equal(built.breakdown.subtotal, 1499 + 1799 * 2);
});

await check('the breakdown matches the pricing engine called directly — one implementation', () => {
  const items = [item(), item({ variantSku: 'TEE-BLK-M', templateSlug: 'tshirt', designId: 'design-2' })];
  const built = build(items);
  const lines = [
    { sku: 'MUG-11-WHT', unitPrice: 1499, quantity: 1 },
    { sku: 'TEE-BLK-M', unitPrice: 2199, quantity: 1 },
  ];
  const shipping = shippingFor('domestic', 2, priceCart({ lines }).taxableBase);
  assert.deepEqual(built.breakdown, priceCart({ lines, shipping }));
});

await check('free shipping is judged on the post-discount goods amount', () => {
  // 4 mugs = 5996 > the 5000 domestic threshold... but a 20% code drops the
  // goods to 4797, so shipping must be charged.
  const items = [item({ quantity: 4 })];
  const withCode = build(items, { discount: { code: 'TWENTY', kind: 'percent', value: 20 } });
  assert.ok(withCode.breakdown.shipping > 0, 'discounted below the threshold — not free');
  const withoutCode = build(items);
  assert.equal(withoutCode.breakdown.shipping, 0, 'undiscounted 5996 clears the threshold');
});

await check('duplicate SKUs keep their own designs, positionally', () => {
  const built = build([
    item({ designId: 'design-dog' }),
    item({ designId: 'design-cat', spec: applyPatch(DEFAULT_SPEC, { transform: { x: 0.3 } }) }),
  ]);
  assert.equal(built.orderItems.length, 2);
  assert.equal(built.orderItems[0]!.designId, 'design-dog');
  assert.equal(built.orderItems[1]!.designId, 'design-cat');
  assert.equal(built.orderItems[1]!.spec.transform.x, 0.3);
});

await check('unknown SKU is rejected with something the user can act on', () => {
  assert.throws(
    () => build([item({ variantSku: 'NOPE-1' })]),
    (e: unknown) => isCheckoutValidationError(e) && /don't sell/.test((e as Error).message),
  );
});

await check('a retired variant cannot be purchased', () => {
  assert.throws(
    () => build([item({ variantSku: 'OLD-SKU' })]),
    (e: unknown) => isCheckoutValidationError(e) && /no longer available/.test((e as Error).message),
  );
});

await check('a template/SKU mismatch means a confused client — refused before payment', () => {
  assert.throws(
    () => build([item({ templateSlug: 'tshirt' })]), // MUG sku claiming to be a tshirt
    (e: unknown) => isCheckoutValidationError(e) && /belongs to/.test((e as Error).message),
  );
});

await check('an invalid spec is rejected with its field named', () => {
  const bad = structuredClone(DEFAULT_SPEC) as { transform: { scale: number } };
  bad.transform.scale = 0.5;
  assert.throws(
    () => build([item({ spec: bad })]),
    (e: unknown) => isCheckoutValidationError(e) && /transform\.scale/.test((e as Error).message),
  );
});

await check('quantity must be a whole number between 1 and 99', () => {
  for (const q of [0, -1, 2.5, 100, NaN]) {
    assert.throws(() => build([item({ quantity: q })]), (e: unknown) => isCheckoutValidationError(e));
  }
});

await check('an empty cart cannot check out', () => {
  assert.throws(() => build([]), /empty/);
});

await check('a missing design id is refused — an order item must point at real pixels', () => {
  assert.throws(
    () => build([item({ designId: '' })]),
    (e: unknown) => isCheckoutValidationError(e) && /no saved design/.test((e as Error).message),
  );
});

// --- The webhook state machine ------------------------------------------------------

function fakeDb(initial: WebhookOrder[]): WebhookDb & { calls: string[] } {
  const orders = new Map(initial.map((o) => [o.id, { ...o }]));
  const bySession = new Map(initial.map((o, i) => [`sess-${i + 1}`, o.id]));
  const calls: string[] = [];
  return {
    calls,
    async getOrderBySession(sessionId) {
      const id = bySession.get(sessionId);
      return id ? { ...orders.get(id)! } : null;
    },
    async getOrderById(orderId) {
      const o = orders.get(orderId);
      return o ? { ...o } : null;
    },
    async markPaid(orderId) {
      calls.push(`markPaid:${orderId}`);
      orders.get(orderId)!.status = 'paid';
    },
    async markExpired(orderId) {
      calls.push(`markExpired:${orderId}`);
      orders.get(orderId)!.status = 'expired';
    },
    async markRefunded(orderId) {
      calls.push(`markRefunded:${orderId}`);
      orders.get(orderId)!.status = 'refunded';
    },
  };
}

await check('completed: pending becomes paid, and the onPaid hook fires exactly once', async () => {
  const db = fakeDb([{ id: 'ord-1', status: 'pending' }]);
  const paidHook: string[] = [];
  const first = await applyStripeEvent(db, { type: 'checkout.session.completed', sessionId: 'sess-1' }, {
    onPaid: async (id) => void paidHook.push(id),
  });
  assert.deepEqual(first, { action: 'paid', orderId: 'ord-1' });

  // Stripe redelivers. The replay must be a provable no-op: no second write,
  // no second fulfilment kick.
  const replay = await applyStripeEvent(db, { type: 'checkout.session.completed', sessionId: 'sess-1' }, {
    onPaid: async (id) => void paidHook.push(id),
  });
  assert.equal(replay.action, 'noop');
  assert.deepEqual(db.calls, ['markPaid:ord-1']);
  assert.deepEqual(paidHook, ['ord-1']);
});

await check('expired: pending expires; a paid order is never downgraded by a late expiry', async () => {
  const db = fakeDb([
    { id: 'ord-1', status: 'pending' },
    { id: 'ord-2', status: 'paid' },
  ]);
  const expired = await applyStripeEvent(db, { type: 'checkout.session.expired', sessionId: 'sess-1' });
  assert.deepEqual(expired, { action: 'expired', orderId: 'ord-1' });

  const race = await applyStripeEvent(db, { type: 'checkout.session.expired', sessionId: 'sess-2' });
  assert.equal(race.action, 'noop');
  assert.deepEqual(db.calls, ['markExpired:ord-1']);
});

await check('refunded: paid becomes refunded once; replay and pre-payment refunds are no-ops', async () => {
  const db = fakeDb([{ id: 'ord-1', status: 'paid' }, { id: 'ord-2', status: 'pending' }]);
  const first = await applyStripeEvent(db, { type: 'charge.refunded', orderId: 'ord-1' });
  assert.deepEqual(first, { action: 'refunded', orderId: 'ord-1' });
  const replay = await applyStripeEvent(db, { type: 'charge.refunded', orderId: 'ord-1' });
  assert.equal(replay.action, 'noop');
  const unpaid = await applyStripeEvent(db, { type: 'charge.refunded', orderId: 'ord-2' });
  assert.equal(unpaid.action, 'noop');
  assert.deepEqual(db.calls, ['markRefunded:ord-1']);
});

await check('an unknown session or order acknowledges without touching anything', async () => {
  const db = fakeDb([{ id: 'ord-1', status: 'pending' }]);
  const bySession = await applyStripeEvent(db, { type: 'checkout.session.completed', sessionId: 'sess-999' });
  assert.deepEqual(bySession, { action: 'unknown-order' });
  const byId = await applyStripeEvent(db, { type: 'charge.refunded', orderId: 'ord-999' });
  assert.deepEqual(byId, { action: 'unknown-order' });
  assert.deepEqual(db.calls, []);
});

console.log(`\n${count} assertions passed.`);
