// The server-side checkout recompute. The client sends design specs, SKUs and
// quantities — NEVER a price. This builder re-reads everything from
// database-sourced rows, recomputes bundles/discounts/tax/shipping through
// the same engine the UI used for display, and produces the order rows that
// get charged. RLS gives clients zero write access to orders specifically so
// this path cannot be bypassed.
//
// Pure: all data comes in as arguments (the route loads it from Supabase),
// so every branch is testable without a server.

import { priceCart } from '../pricing/engine';
import { shippingFor } from '../pricing/shipping';
import type { BundleRule, CartLine, Cents, Discount, PriceBreakdown } from '../pricing/types';
import { parseDesignSpec } from '../mockup/spec';
import type { DesignSpec } from '../mockup/types';
import { zipByPosition } from './mapping';

// What one cart line looks like on the wire (see cartStore.toCheckoutPayload,
// plus the design id from /api/designs/persist, aligned by position).
export interface CheckoutItemInput {
  templateSlug: string;
  variantSku: string;
  quantity: number;
  spec: unknown; // validated here — the client's type claims mean nothing
  designId: string;
}

// A variant as the route reads it from the database. price is the retail
// price the customer will actually be charged, whatever the client displayed.
export interface VariantRow {
  variantId: string;
  templateId: string;
  templateSlug: string;
  templateName: string;
  variantName: string;
  price: Cents;
  variantActive: boolean;
  templateActive: boolean;
}

export interface BuildCheckoutInputs {
  items: CheckoutItemInput[];
  variantsBySku: ReadonlyMap<string, VariantRow>;
  bundles: BundleRule[];
  discount: Discount | null;
  taxRate?: number;
  shippingZoneId: string;
}

export interface OrderItemRow {
  designId: string;
  variantId: string;
  quantity: number;
  unitPrice: Cents;
  spec: DesignSpec;
}

export interface BuiltCheckout {
  breakdown: PriceBreakdown;
  // Positionally aligned with the input items — see mapping.ts.
  orderItems: OrderItemRow[];
  // Human-readable order summary for the Stripe session.
  description: string;
}

export class CheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutValidationError';
  }
}

// Name check, never instanceof — see CLAUDE.md.
export function isCheckoutValidationError(e: unknown): e is CheckoutValidationError {
  return (
    typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'CheckoutValidationError'
  );
}

const MAX_QUANTITY = 99;

export function buildCheckoutOrder(inputs: BuildCheckoutInputs): BuiltCheckout {
  const { items, variantsBySku } = inputs;

  if (items.length === 0) {
    throw new CheckoutValidationError('Your cart is empty — add an item before checking out.');
  }

  // Validate every item; collect the parsed specs positionally.
  const specs: DesignSpec[] = [];
  const variants: VariantRow[] = [];
  items.forEach((item, i) => {
    const at = `item ${i + 1}`;

    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) {
      throw new CheckoutValidationError(
        `Quantity for ${at} must be a whole number between 1 and ${MAX_QUANTITY}.`,
      );
    }

    const variant = variantsBySku.get(item.variantSku);
    if (!variant) {
      throw new CheckoutValidationError(
        `${at} refers to a product we don't sell ("${item.variantSku}"). Remove it and re-add from the catalogue.`,
      );
    }
    if (!variant.variantActive || !variant.templateActive) {
      throw new CheckoutValidationError(
        `"${variant.templateName} — ${variant.variantName}" is no longer available. Remove it from your cart.`,
      );
    }
    // The slug is redundant with the SKU on purpose: a mismatch means the
    // client is confused about what it's selling, and a confused client must
    // not reach payment.
    if (variant.templateSlug !== item.templateSlug) {
      throw new CheckoutValidationError(
        `${at} claims to be "${item.templateSlug}" but its SKU belongs to "${variant.templateSlug}".`,
      );
    }
    if (!item.designId) {
      throw new CheckoutValidationError(`${at} has no saved design — try again.`);
    }

    const parsed = parseDesignSpec(item.spec);
    if (!parsed.ok) {
      throw new CheckoutValidationError(`${at}: ${parsed.error}`);
    }

    specs.push(parsed.spec);
    variants.push(variant);
  });

  // Engine lines built by .map over items — position IS identity.
  const lines: CartLine[] = items.map((item, i) => ({
    sku: item.variantSku,
    unitPrice: variants[i]!.price,
    quantity: item.quantity,
  }));

  // Shipping depends on the post-discount goods amount (free-shipping
  // thresholds judge what the customer actually pays), so price twice:
  // once to learn the goods amount, once with shipping in place.
  const goodsOnly = priceCart({
    lines,
    bundles: inputs.bundles,
    discount: inputs.discount,
    taxRate: inputs.taxRate ?? 0,
  });
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
  const shipping = shippingFor(inputs.shippingZoneId, itemCount, goodsOnly.taxableBase);
  const breakdown = priceCart({
    lines,
    bundles: inputs.bundles,
    discount: inputs.discount,
    taxRate: inputs.taxRate ?? 0,
    shipping,
  });

  const orderItems = zipByPosition(items, lines, (item, line, i) => ({
    designId: item.designId,
    variantId: variants[i]!.variantId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    spec: specs[i]!,
  }));

  const description = items
    .map((item, i) => `${item.quantity}x ${variants[i]!.templateName} (${variants[i]!.variantName})`)
    .join(', ');

  return { breakdown, orderItems, description };
}
