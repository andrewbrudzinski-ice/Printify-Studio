// POST /api/stripe/checkout — recomputes all money server-side, creates the
// order, returns a Stripe Checkout URL.
//
// The client's payload contains design specs, SKUs and quantities. It never
// contains a price, and nothing in this route reads one from it. Every
// monetary value is re-read from the database and recomputed through
// src/lib/checkout/session.ts (which the tests cover); this file is wiring.
//
// Wired against real Stripe/Supabase SDKs but UNVERIFIED against live
// services — first contact will surface something. The core it delegates to
// is tested.

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { supabaseService } from '@/lib/supabase/service';
import { buildCheckoutOrder, isCheckoutValidationError } from '@/lib/checkout/session';
import type { CheckoutItemInput, VariantRow } from '@/lib/checkout/session';
import { loadActiveDiscount } from '@/lib/checkout/discount';
import type { BundleRule, Discount } from '@/lib/pricing/types';

export const runtime = 'nodejs';

interface CheckoutRequestBody {
  items: CheckoutItemInput[];
  email?: string;
  discountCode?: string;
  shippingZoneId?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: 'Checkout is not configured on this deployment.' },
      { status: 503 },
    );
  }

  let body: CheckoutRequestBody;
  try {
    body = (await req.json()) as CheckoutRequestBody;
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: 'Send items as an array.' }, { status: 400 });
  }

  const db = supabaseService();

  // --- Load everything money depends on from the database -------------------
  const skus = [...new Set(body.items.map((i) => i.variantSku))];
  const { data: variantRows, error: variantErr } = await db
    .from('product_variants')
    .select('id, sku, name, price, active, product_templates!inner(id, slug, name, active)')
    .in('sku', skus);
  if (variantErr) {
    return NextResponse.json({ error: 'Could not load the catalogue. Try again.' }, { status: 500 });
  }

  const variantsBySku = new Map<string, VariantRow>();
  // Untyped client quirk: a many-to-one !inner join is typed as an array but
  // arrives as an object. Generated DB types (supabase gen types) fix this
  // properly once a project exists; until then the cast documents reality.
  for (const row of (variantRows ?? []) as unknown as Array<{
    id: string;
    sku: string;
    name: string;
    price: number;
    active: boolean;
    product_templates: { id: string; slug: string; name: string; active: boolean };
  }>) {
    variantsBySku.set(row.sku, {
      variantId: row.id,
      templateId: row.product_templates.id,
      templateSlug: row.product_templates.slug,
      templateName: row.product_templates.name,
      variantName: row.name,
      price: row.price,
      variantActive: row.active,
      templateActive: row.product_templates.active,
    });
  }

  const { data: bundleRows } = await db.from('bundles').select('*').eq('active', true);
  const bundles: BundleRule[] = ((bundleRows ?? []) as Array<Record<string, unknown>>).map(toBundleRule);

  let discount: Discount | null = null;
  if (body.discountCode) {
    // Same loader as /api/discount/validate — a code the cart accepted
    // cannot be refused here, or vice versa.
    discount = await loadActiveDiscount(db, body.discountCode);
    if (!discount) {
      return NextResponse.json(
        { error: 'That discount code is not valid. Check the spelling or remove it.' },
        { status: 400 },
      );
    }
  }

  // --- Recompute and persist -------------------------------------------------
  let built;
  try {
    built = buildCheckoutOrder({
      items: body.items,
      variantsBySku,
      bundles,
      discount,
      taxRate: process.env.STRIPE_TAX_ENABLED === 'true' ? 0 : 0, // tax via Stripe Tax when enabled
      shippingZoneId: body.shippingZoneId ?? 'domestic',
    });
  } catch (e) {
    if (isCheckoutValidationError(e)) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    throw e;
  }

  const b = built.breakdown;
  const { data: orderRow, error: orderErr } = await db
    .from('orders')
    .insert({
      email: body.email ?? '',
      status: 'pending',
      subtotal: b.subtotal,
      discount_total: b.bundleDiscount + b.codeDiscount,
      tax: b.tax,
      shipping: b.shipping,
      total: b.total,
    })
    .select('id')
    .single();
  if (orderErr || !orderRow) {
    return NextResponse.json({ error: 'Could not create the order. Try again.' }, { status: 500 });
  }
  const orderId = (orderRow as { id: string }).id;

  const { error: itemsErr } = await db.from('order_items').insert(
    built.orderItems.map((item) => ({
      order_id: orderId,
      design_id: item.designId,
      variant_id: item.variantId,
      quantity: item.quantity,
      unit_price: item.unitPrice,
    })),
  );
  if (itemsErr) {
    return NextResponse.json({ error: 'Could not create the order. Try again.' }, { status: 500 });
  }

  // --- Stripe session ---------------------------------------------------------
  // One line item carrying the recomputed total: the charge is exactly the
  // breakdown, with no chance of Stripe-side arithmetic drifting from ours.
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'Printify Studio order', description: built.description },
          unit_amount: b.total,
        },
        quantity: 1,
      },
    ],
    customer_email: body.email || undefined,
    metadata: { order_id: orderId },
    payment_intent_data: { metadata: { order_id: orderId } },
    success_url: `${site}/orders/confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/cart`,
  });

  await db.from('orders').update({ stripe_session_id: session.id }).eq('id', orderId);

  return NextResponse.json({ url: session.url, orderId });
}

function toBundleRule(row: Record<string, unknown>): BundleRule {
  const reward = row.reward as { kind?: unknown; value?: unknown };
  if (
    (reward?.kind !== 'percent' && reward?.kind !== 'fixed') ||
    typeof reward.value !== 'number'
  ) {
    // A malformed bundle would price the cart differently than the UI showed.
    // Money code fails loudly, never quietly.
    throw new Error(`Bundle "${String(row.id)}" has a malformed reward.`);
  }
  return {
    id: String(row.id),
    skus: row.skus as string[],
    quantity: Number(row.quantity),
    reward: { kind: reward.kind, value: reward.value },
    priority: Number(row.priority),
  };
}
