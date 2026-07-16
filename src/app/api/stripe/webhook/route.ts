// POST /api/stripe/webhook — confirms payment, idempotently.
//
// Pinned to the Node runtime: signature verification needs the RAW request
// body, which the edge runtime doesn't provide.
//
// The transition logic lives in src/lib/checkout/webhook.ts (tested); this
// file verifies the signature, maps the Stripe event into the neutral shape,
// and wires a Supabase-service-backed WebhookDb. Print generation + provider
// handoff run inline off the onPaid hook via src/lib/fulfilment/submit.ts.

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { supabaseService } from '@/lib/supabase/service';
import { applyStripeEvent } from '@/lib/checkout/webhook';
import type { StripeEventLike, WebhookDb, WebhookOrder } from '@/lib/checkout/webhook';
import { fulfilOrder } from '@/lib/fulfilment/submit';
import { makeFulfilmentDeps } from '@/lib/fulfilment/wire';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !secret || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 });
  }

  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header.' }, { status: 400 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event: Stripe.Event;
  try {
    // The local `stripe listen` secret differs from the Dashboard endpoint's
    // secret. Using the wrong one fails here — check that before anything else.
    event = stripe.webhooks.constructEvent(await req.text(), signature, secret);
  } catch {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  const mapped = mapEvent(event);
  if (!mapped) {
    // An event type we didn't subscribe to; acknowledge so Stripe stops
    // retrying something we'll never handle.
    return NextResponse.json({ received: true, ignored: event.type });
  }

  const outcome = await applyStripeEvent(makeDb(), mapped, {
    // Fires exactly once per order (never on a replay — the state machine
    // guarantees it). fulfilOrder settles the order to a terminal fulfilment
    // state itself; nothing here may throw back at Stripe, or Stripe would
    // retry a payment confirmation that already succeeded.
    async onPaid(orderId) {
      try {
        await fulfilOrder(makeFulfilmentDeps(), orderId);
      } catch (e) {
        console.error(`fulfilment for order ${orderId} crashed:`, e);
      }
    },
  });
  return NextResponse.json({ received: true, outcome });
}

function mapEvent(event: Stripe.Event): StripeEventLike | null {
  switch (event.type) {
    case 'checkout.session.completed':
      return { type: 'checkout.session.completed', sessionId: event.data.object.id };
    case 'checkout.session.expired':
      return { type: 'checkout.session.expired', sessionId: event.data.object.id };
    case 'charge.refunded': {
      // Charges don't carry the session id; checkout stamped order_id into
      // the payment intent's metadata, which the charge inherits.
      const orderId = event.data.object.metadata?.order_id;
      return orderId ? { type: 'charge.refunded', orderId } : null;
    }
    default:
      return null;
  }
}

function makeDb(): WebhookDb {
  const db = supabaseService();
  const asOrder = (row: unknown): WebhookOrder | null =>
    row ? (row as WebhookOrder) : null;
  return {
    async getOrderBySession(sessionId) {
      const { data } = await db
        .from('orders')
        .select('id, status')
        .eq('stripe_session_id', sessionId)
        .maybeSingle();
      return asOrder(data);
    },
    async getOrderById(orderId) {
      const { data } = await db.from('orders').select('id, status').eq('id', orderId).maybeSingle();
      return asOrder(data);
    },
    async markPaid(orderId) {
      await db.from('orders').update({ status: 'paid' }).eq('id', orderId).eq('status', 'pending');
    },
    async markExpired(orderId) {
      await db.from('orders').update({ status: 'expired' }).eq('id', orderId).eq('status', 'pending');
    },
    async markRefunded(orderId) {
      await db.from('orders').update({ status: 'refunded' }).eq('id', orderId).eq('status', 'paid');
    },
  };
}
