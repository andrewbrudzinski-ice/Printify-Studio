// The money vocabulary for the whole app.
//
// RULE: money is an integer count of minor units (cents). Never a float, never
// a `number` that might be dollars. Every value produced by the pricing engine
// is an integer, and every value fed into it must be one too. Floats in money
// math accumulate rounding error that shows up as a cart total that disagrees
// with the charged total by a cent — the one class of bug a payments system
// can least afford.
export type Cents = number;

// A single priced row in the cart. `unitPrice` is the RETAIL price the customer
// sees, per unit — never wholesale cost. On the server these values are re-read
// from the database; the client's numbers are only ever used for display.
export interface CartLine {
  sku: string;
  unitPrice: Cents;
  quantity: number;
}

// A bundle rewards buying `quantity` qualifying units together. Two shapes:
//   percent — take N% off the qualifying group's price
//   fixed   — take a flat number of cents off the group (clamped to the group,
//             so a bundle can never make a group cost less than nothing)
export type BundleReward =
  | { kind: 'percent'; value: number } // 0..100
  | { kind: 'fixed'; value: Cents };

export interface BundleRule {
  id: string;
  // The SKUs that count toward this bundle. A unit qualifies if its SKU is here.
  skus: string[];
  // How many qualifying units form one bundle.
  quantity: number;
  reward: BundleReward;
  // Higher priority is applied first. Because bundles consume from a shared pool
  // of units (see engine.ts), priority decides who gets the stock when two
  // bundles compete for the same items.
  priority: number;
}

// A discount code, applied once, AFTER all bundles. Percent applies to the
// post-bundle subtotal; fixed is a flat cents amount. Either way the engine
// clamps it so a discount can never exceed what's left to discount.
export type Discount =
  | { code: string; kind: 'percent'; value: number } // 0..100
  | { code: string; kind: 'fixed'; value: Cents };

export interface PriceInput {
  lines: CartLine[];
  bundles?: BundleRule[];
  discount?: Discount | null;
  // Fractional tax rate, e.g. 0.08875. Applied to the POST-discount goods
  // amount only — not to shipping, not to the pre-discount subtotal.
  taxRate?: number;
  // Resolved shipping amount in cents (see shipping.ts to compute it).
  shipping?: Cents;
}

export interface AppliedBundle {
  id: string;
  // How many times this bundle formed from the pool.
  times: number;
  discount: Cents;
}

// The full, itemised result. Every field is an integer number of cents. The
// identity `total === taxableBase + tax + shipping` always holds, and
// `taxableBase === subtotal - bundleDiscount - codeDiscount`.
export interface PriceBreakdown {
  subtotal: Cents;
  bundleDiscount: Cents;
  appliedBundles: AppliedBundle[];
  discountCode: string | null;
  codeDiscount: Cents;
  taxableBase: Cents;
  tax: Cents;
  shipping: Cents;
  total: Cents;
}
