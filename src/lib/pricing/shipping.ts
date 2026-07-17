import type { Cents } from './types';

// Shipping is a zone lookup plus a per-item add and an optional free-shipping
// threshold. It is intentionally separate from the pricing engine: shipping
// policy changes far more often than the money math, and the engine takes an
// already-resolved `shipping` amount so a promo like "free shipping over $50"
// is a shipping-layer decision, not a special case buried in tax ordering.

export interface ShippingZone {
  id: string;
  label: string;
  // Flat cost to ship an order to this zone.
  base: Cents;
  // Added per item beyond the first — heavier baskets cost more to ship.
  perItem: Cents;
  // Order goods amount (post-discount) at or above which shipping is free.
  // Omit for zones that never qualify for free shipping.
  freeThreshold?: Cents;
}

// Deliberately small and explicit. Real zones live in config/data later; this
// is enough to price a cart and to test the threshold and per-item math.
export const SHIPPING_ZONES: Record<string, ShippingZone> = {
  domestic: { id: 'domestic', label: 'Domestic', base: 499, perItem: 150, freeThreshold: 5000 },
  canada: { id: 'canada', label: 'Canada', base: 1299, perItem: 300 },
  international: { id: 'international', label: 'International', base: 1999, perItem: 500 },
};

// Resolve the shipping cost for an order. `goodsAmount` is the post-discount
// goods total in cents — the same base tax is computed on — so the free
// threshold is judged against what the customer actually pays for goods.
export function shippingFor(
  zoneId: string,
  itemCount: number,
  goodsAmount: Cents,
): Cents {
  const zone = SHIPPING_ZONES[zoneId];
  if (!zone) {
    throw new Error(
      `Unknown shipping zone "${zoneId}". Choose a country/region at checkout.`,
    );
  }

  if (zone.freeThreshold !== undefined && goodsAmount >= zone.freeThreshold) {
    return 0;
  }

  const extraItems = Math.max(0, itemCount - 1);
  return zone.base + extraItems * zone.perItem;
}
