import type {
  AppliedBundle,
  BundleRule,
  CartLine,
  Cents,
  Discount,
  PriceBreakdown,
  PriceInput,
} from './types';

// This is the ONLY money implementation. The cart UI and the Stripe checkout
// route both call priceCart() with the same inputs, so the total the customer
// approves and the total we charge are computed by the same code — they cannot
// drift apart. Do not add a second pricing path anywhere; a discrepancy between
// two implementations would only surface as a customer charged the wrong amount.

// Half-up rounding to whole cents. For the non-negative amounts money math
// produces, `Math.floor(n + 0.5)` rounds a trailing .5 up, which is the
// convention customers and tax authorities expect. `Math.round` agrees for
// positives but rounds -0.5 toward zero; we spell it out so the intent is
// explicit and doesn't depend on that asymmetry.
function roundHalfUp(n: number): Cents {
  return Math.floor(n + 0.5);
}

// One physical unit sitting in the pool, tagged with the price it contributes.
interface Unit {
  sku: string;
  unitPrice: Cents;
}

// Explode lines into individual units so bundles can consume them one group at
// a time. A three-quantity line becomes three units; each carries its own price
// so a bundle's percent discount is computed against the exact units it claims.
function explode(lines: CartLine[]): Unit[] {
  const units: Unit[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.quantity; i++) {
      units.push({ sku: line.sku, unitPrice: line.unitPrice });
    }
  }
  return units;
}

// Apply bundles greedily against a shared pool of units.
//
// The shared pool is the whole point: a unit consumed by one bundle is removed,
// so overlapping bundles (two rules that both accept 'MUG-11-WHT') can never
// double-count the same physical item. Without this, five mugs matched by two
// "buy 3" rules would report six mugs' worth of discount and undercharge.
//
// Highest priority applies first and takes as many full bundles as the pool
// allows before the next rule sees what's left. Within a bundle we claim the
// most expensive qualifying units first, so a percent reward discounts the
// priciest items — deterministic, and the friendlier reading for the customer.
function applyBundles(
  units: Unit[],
  bundles: BundleRule[],
): { bundleDiscount: Cents; applied: AppliedBundle[] } {
  // Don't mutate the caller's array; we splice from this copy.
  const pool = units.slice();
  const applied: AppliedBundle[] = [];
  let bundleDiscount = 0;

  const ordered = bundles.slice().sort((a, b) => b.priority - a.priority);

  for (const bundle of ordered) {
    if (bundle.quantity <= 0) continue;
    const qualifies = new Set(bundle.skus);

    let times = 0;
    let discountForBundle = 0;

    // Keep forming this bundle until the pool can't supply another full group.
    for (;;) {
      // Indices of qualifying units, most expensive first.
      const candidates = pool
        .map((u, i) => ({ i, price: u.unitPrice, sku: u.sku }))
        .filter((c) => qualifies.has(c.sku))
        .sort((a, b) => b.price - a.price);

      if (candidates.length < bundle.quantity) break;

      const claim = candidates.slice(0, bundle.quantity);
      const groupPrice = claim.reduce((sum, c) => sum + c.price, 0);

      let discount: Cents;
      if (bundle.reward.kind === 'percent') {
        discount = roundHalfUp((groupPrice * bundle.reward.value) / 100);
      } else {
        // A fixed reward can never exceed the group it discounts — otherwise a
        // cheap group plus a large flat bundle would go negative.
        discount = Math.min(bundle.reward.value, groupPrice);
      }

      discountForBundle += discount;
      times += 1;

      // Remove claimed units from the pool. Splice from the highest index down
      // so earlier removals don't shift the indices we still need to remove.
      const removeAt = claim.map((c) => c.i).sort((a, b) => b - a);
      for (const idx of removeAt) pool.splice(idx, 1);
    }

    if (times > 0) {
      applied.push({ id: bundle.id, times, discount: discountForBundle });
      bundleDiscount += discountForBundle;
    }
  }

  return { bundleDiscount, applied };
}

// Compute the discount-code amount against the post-bundle subtotal. Clamped so
// it can never exceed what's left — a discount must not create a negative order.
function codeDiscountFor(discount: Discount, afterBundles: Cents): Cents {
  const raw =
    discount.kind === 'percent'
      ? roundHalfUp((afterBundles * discount.value) / 100)
      : discount.value;
  return Math.min(Math.max(raw, 0), afterBundles);
}

export function priceCart(input: PriceInput): PriceBreakdown {
  const lines = input.lines;
  const bundles = input.bundles ?? [];
  const discount = input.discount ?? null;
  const taxRate = input.taxRate ?? 0;
  const shipping = input.shipping ?? 0;

  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0,
  );

  // 1. Bundles first, consuming from a shared pool.
  const { bundleDiscount, applied } = applyBundles(explode(lines), bundles);
  const afterBundles = subtotal - bundleDiscount;

  // 2. Discount code second — applied to the already-bundled amount, so a
  //    percent code discounts what the customer would actually pay for goods,
  //    not the pre-bundle sticker price.
  const codeDiscount = discount ? codeDiscountFor(discount, afterBundles) : 0;

  // 3. Tax on the post-discount goods amount only. Not on shipping, and never
  //    on the pre-discount subtotal — taxing money the customer isn't paying
  //    for goods over-charges them.
  const taxableBase = afterBundles - codeDiscount;
  const tax = roundHalfUp(taxableBase * taxRate);

  const total = taxableBase + tax + shipping;

  return {
    subtotal,
    bundleDiscount,
    appliedBundles: applied,
    discountCode: discount ? discount.code : null,
    codeDiscount,
    taxableBase,
    tax,
    shipping,
    total,
  };
}
