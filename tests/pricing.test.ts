import assert from 'node:assert/strict';
import { priceCart } from '../src/lib/pricing/engine';
import { shippingFor, SHIPPING_ZONES } from '../src/lib/pricing/shipping';
import type { BundleRule, Discount, PriceBreakdown } from '../src/lib/pricing/types';

// Real assertions against the real engine — no mocks. Money math is exactly the
// place where a mock that "returns the right number" proves nothing; every
// check below runs the production priceCart().

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  // One line per assertion so a failure points at the behaviour, not a stack.
  console.log(`  ok  ${label}`);
}

// Assert every monetary field of a breakdown is a whole number of cents. This
// is the integer-only guarantee, checked structurally rather than trusting each
// individual case to have used round numbers.
function assertAllIntegers(b: PriceBreakdown): void {
  for (const key of [
    'subtotal',
    'bundleDiscount',
    'codeDiscount',
    'taxableBase',
    'tax',
    'shipping',
    'total',
  ] as const) {
    assert.ok(
      Number.isInteger(b[key]),
      `${key} must be an integer, got ${b[key]}`,
    );
  }
  for (const ab of b.appliedBundles) {
    assert.ok(Number.isInteger(ab.discount), `applied bundle discount not integer`);
  }
}

// --- Subtotal & structure --------------------------------------------------

check('subtotal sums unitPrice * quantity', () => {
  const b = priceCart({ lines: [{ sku: 'MUG', unitPrice: 1500, quantity: 2 }] });
  assert.equal(b.subtotal, 3000);
});

check('empty cart is all zeros', () => {
  const b = priceCart({ lines: [] });
  assert.equal(b.subtotal, 0);
  assert.equal(b.total, 0);
});

check('no bundles/discount/tax → total equals subtotal', () => {
  const b = priceCart({ lines: [{ sku: 'MUG', unitPrice: 1234, quantity: 3 }] });
  assert.equal(b.total, 3702);
});

check('breakdown identity: total === taxableBase + tax + shipping', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1500, quantity: 4 }],
    taxRate: 0.0825,
    shipping: 499,
  });
  assert.equal(b.total, b.taxableBase + b.tax + b.shipping);
});

check('breakdown identity: taxableBase === subtotal - bundleDiscount - codeDiscount', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 3 }],
    bundles: [{ id: 'b', skus: ['MUG'], quantity: 3, reward: { kind: 'percent', value: 10 }, priority: 1 }],
    discount: { code: 'SAVE', kind: 'fixed', value: 200 },
  });
  assert.equal(b.taxableBase, b.subtotal - b.bundleDiscount - b.codeDiscount);
});

// --- Bundle greediness -----------------------------------------------------

const buy3Mugs: BundleRule = {
  id: 'mug-3',
  skus: ['MUG'],
  quantity: 3,
  reward: { kind: 'percent', value: 10 },
  priority: 10,
};

check('bundle greediness: applies as many full bundles as the pool allows', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 6 }],
    bundles: [buy3Mugs],
  });
  // 6 mugs → two full "buy 3" bundles. Each group of 3 is 3000; 10% = 300.
  assert.equal(b.appliedBundles[0]?.times, 2);
  assert.equal(b.bundleDiscount, 600);
});

check('bundle greediness: leftover units below the threshold are not discounted', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 5 }],
    bundles: [buy3Mugs],
  });
  // 5 mugs → one bundle of 3 (discount 300), 2 left over untouched.
  assert.equal(b.appliedBundles[0]?.times, 1);
  assert.equal(b.bundleDiscount, 300);
});

check('bundle not met at all → no discount, no applied entry', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 2 }],
    bundles: [buy3Mugs],
  });
  assert.equal(b.bundleDiscount, 0);
  assert.equal(b.appliedBundles.length, 0);
});

check('bundle claims the most expensive qualifying units first', () => {
  const b = priceCart({
    lines: [
      { sku: 'MUG', unitPrice: 2000, quantity: 1 },
      { sku: 'MUG', unitPrice: 1000, quantity: 2 },
    ],
    // buy any 2 mugs, 50% off the group
    bundles: [{ id: 'm2', skus: ['MUG'], quantity: 2, reward: { kind: 'percent', value: 50 }, priority: 1 }],
  });
  // Most expensive two are 2000 + 1000 = 3000; 50% = 1500.
  assert.equal(b.bundleDiscount, 1500);
});

// --- Overlapping bundles: shared pool, no double-consuming ------------------

check('overlapping bundles do not double-consume the same stock', () => {
  const a: BundleRule = { id: 'a', skus: ['MUG'], quantity: 3, reward: { kind: 'fixed', value: 300 }, priority: 20 };
  const c: BundleRule = { id: 'c', skus: ['MUG'], quantity: 3, reward: { kind: 'fixed', value: 300 }, priority: 10 };
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 5 }],
    bundles: [a, c],
  });
  // 5 mugs: higher-priority 'a' takes 3 (discount 300). Only 2 remain, so 'c'
  // cannot form a group of 3. Total discount is 300, NOT 600.
  assert.equal(b.bundleDiscount, 300);
  assert.equal(b.appliedBundles.length, 1);
  assert.equal(b.appliedBundles[0]?.id, 'a');
});

check('higher priority bundle consumes the pool first', () => {
  const cheapBundle: BundleRule = { id: 'cheap', skus: ['MUG'], quantity: 2, reward: { kind: 'fixed', value: 100 }, priority: 1 };
  const richBundle: BundleRule = { id: 'rich', skus: ['MUG'], quantity: 2, reward: { kind: 'fixed', value: 900 }, priority: 100 };
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 2 }],
    bundles: [cheapBundle, richBundle],
  });
  // Only enough stock for ONE bundle of 2. The high-priority 'rich' wins it.
  assert.equal(b.appliedBundles.length, 1);
  assert.equal(b.appliedBundles[0]?.id, 'rich');
  assert.equal(b.bundleDiscount, 900);
});

check('a bundle spanning multiple SKUs pools across them', () => {
  const mixed: BundleRule = { id: 'mixed', skus: ['MUG', 'TEE'], quantity: 3, reward: { kind: 'percent', value: 10 }, priority: 1 };
  const b = priceCart({
    lines: [
      { sku: 'MUG', unitPrice: 1000, quantity: 2 },
      { sku: 'TEE', unitPrice: 2000, quantity: 1 },
    ],
    bundles: [mixed],
  });
  // Group of 3 across SKUs: 2000 + 1000 + 1000 = 4000; 10% = 400.
  assert.equal(b.appliedBundles[0]?.times, 1);
  assert.equal(b.bundleDiscount, 400);
});

// --- Discount-after-bundle ordering ----------------------------------------

check('percent discount code applies to the POST-bundle amount', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 3 }],
    bundles: [buy3Mugs], // -300 → afterBundles 2700
    discount: { code: 'TEN', kind: 'percent', value: 10 },
  });
  // 10% of 2700 (not of 3000) = 270.
  assert.equal(b.codeDiscount, 270);
  assert.equal(b.taxableBase, 2430);
});

check('fixed discount code applies after bundles', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 3 }],
    bundles: [buy3Mugs], // afterBundles 2700
    discount: { code: 'FIVE', kind: 'fixed', value: 500 },
  });
  assert.equal(b.codeDiscount, 500);
  assert.equal(b.taxableBase, 2200);
});

check('discountCode is echoed back, null when absent', () => {
  const withCode = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 1 }],
    discount: { code: 'HELLO', kind: 'percent', value: 5 },
  });
  assert.equal(withCode.discountCode, 'HELLO');
  const without = priceCart({ lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 1 }] });
  assert.equal(without.discountCode, null);
});

// --- Discounts never exceed subtotal ---------------------------------------

check('fixed discount larger than the cart is clamped to the cart', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 1 }],
    discount: { code: 'HUGE', kind: 'fixed', value: 999999 },
  });
  assert.equal(b.codeDiscount, 1000);
  assert.equal(b.taxableBase, 0);
  assert.equal(b.total, 0);
});

check('100% discount zeroes goods but never goes negative', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1500, quantity: 2 }],
    discount: { code: 'FREE', kind: 'percent', value: 100 },
  });
  assert.equal(b.codeDiscount, 3000);
  assert.equal(b.taxableBase, 0);
});

check('discount never exceeds the post-bundle subtotal', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 3 }],
    bundles: [buy3Mugs], // afterBundles 2700
    discount: { code: 'BIG', kind: 'fixed', value: 5000 },
  });
  // Even though the code is 5000, at most 2700 is discountable.
  assert.equal(b.codeDiscount, 2700);
  assert.equal(b.taxableBase, 0);
});

check('fixed bundle reward cannot exceed the group it discounts', () => {
  const b = priceCart({
    lines: [{ sku: 'PIN', unitPrice: 200, quantity: 2 }],
    bundles: [{ id: 'pin2', skus: ['PIN'], quantity: 2, reward: { kind: 'fixed', value: 1000 }, priority: 1 }],
  });
  // Group is only 400; a 1000-off reward is clamped to 400.
  assert.equal(b.bundleDiscount, 400);
  assert.equal(b.total, 0);
});

// --- Tax: post-discount base, half-up rounding, integer output --------------

check('tax is computed on the post-discount base only', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 3 }],
    bundles: [buy3Mugs], // afterBundles 2700
    discount: { code: 'TEN', kind: 'percent', value: 10 }, // -270 → base 2430
    taxRate: 0.1,
  });
  // Tax is 10% of 2430, NOT of 3000 or 2700.
  assert.equal(b.taxableBase, 2430);
  assert.equal(b.tax, 243);
});

check('tax is NOT applied to shipping', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1000, quantity: 1 }],
    taxRate: 0.1,
    shipping: 500,
  });
  // 10% of 1000 = 100, not 10% of 1500.
  assert.equal(b.tax, 100);
  assert.equal(b.total, 1000 + 100 + 500);
});

check('tax rounds half up', () => {
  // base 1005 * 0.10 = 100.5 → 101 (up, not 100).
  const b = priceCart({
    lines: [{ sku: 'X', unitPrice: 1005, quantity: 1 }],
    taxRate: 0.1,
  });
  assert.equal(b.tax, 101);
});

check('tax below the half rounds down', () => {
  // base 1004 * 0.10 = 100.4 → 100.
  const b = priceCart({
    lines: [{ sku: 'X', unitPrice: 1004, quantity: 1 }],
    taxRate: 0.1,
  });
  assert.equal(b.tax, 100);
});

check('a realistic fractional tax rate yields an integer', () => {
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 1499, quantity: 3 }],
    taxRate: 0.08875, // NYC combined
  });
  // 4497 * 0.08875 = 399.10875 → 399.
  assert.equal(b.tax, 399);
  assert.ok(Number.isInteger(b.tax));
});

// --- Integer-only outputs (structural) -------------------------------------

check('all monetary outputs are integers across a compound order', () => {
  const b = priceCart({
    lines: [
      { sku: 'MUG', unitPrice: 1499, quantity: 3 },
      { sku: 'TEE', unitPrice: 2599, quantity: 2 },
    ],
    bundles: [{ id: 'any3', skus: ['MUG', 'TEE'], quantity: 3, reward: { kind: 'percent', value: 15 }, priority: 5 }],
    discount: { code: 'SAVE7', kind: 'percent', value: 7 },
    taxRate: 0.08875,
    shipping: 650,
  });
  assertAllIntegers(b);
});

check('percent bundle reward rounds half up to an integer', () => {
  // group 1005, 50% = 502.5 → 503.
  const b = priceCart({
    lines: [{ sku: 'X', unitPrice: 1005, quantity: 2 }],
    bundles: [{ id: 'h', skus: ['X'], quantity: 2, reward: { kind: 'percent', value: 25 }, priority: 1 }],
  });
  // 2010 * 0.25 = 502.5 → 503.
  assert.equal(b.bundleDiscount, 503);
});

// --- Shipping module -------------------------------------------------------

check('shipping: base plus per-item beyond the first', () => {
  const s = shippingFor('domestic', 3, 3000);
  // base 499 + 2 extra * 150 = 799.
  assert.equal(s, 799);
});

check('shipping: free over the zone threshold', () => {
  const s = shippingFor('domestic', 3, SHIPPING_ZONES.domestic!.freeThreshold!);
  assert.equal(s, 0);
});

check('shipping: unknown zone is a clear, actionable error', () => {
  assert.throws(() => shippingFor('mars', 1, 1000), /Unknown shipping zone/);
});

check('shipping resolves into the engine as the shipping line', () => {
  const zoneCost = shippingFor('canada', 2, 1000);
  const b = priceCart({
    lines: [{ sku: 'MUG', unitPrice: 500, quantity: 2 }],
    shipping: zoneCost,
  });
  assert.equal(b.shipping, zoneCost);
  assert.equal(b.total, 1000 + zoneCost);
});

console.log(`\n${count} assertions passed.`);
