// Stripe webhook state transitions — idempotent by construction. Stripe
// retries deliveries and replays are routine; every transition here checks
// the CURRENT state first, so a replayed event is provably a no-op (pinned
// by test and by the SQL suite's unique stripe_session_id).
//
// The database work is injected: the route wires a Supabase service client
// in, tests wire a recording fake or PGlite. The logic is identical either way.

export type StripeEventLike =
  | { type: 'checkout.session.completed'; sessionId: string }
  | { type: 'checkout.session.expired'; sessionId: string }
  | { type: 'charge.refunded'; orderId: string };

export interface WebhookOrder {
  id: string;
  status: 'pending' | 'paid' | 'refunded' | 'expired';
}

export interface WebhookDb {
  getOrderBySession(sessionId: string): Promise<WebhookOrder | null>;
  getOrderById(orderId: string): Promise<WebhookOrder | null>;
  markPaid(orderId: string): Promise<void>;
  markExpired(orderId: string): Promise<void>;
  markRefunded(orderId: string): Promise<void>;
}

export interface WebhookHooks {
  // Fired exactly once per order, on the pending->paid transition — never on
  // a replay. This is where print generation and provider handoff hang.
  onPaid?(orderId: string): Promise<void>;
}

export type WebhookOutcome =
  | { action: 'paid'; orderId: string }
  | { action: 'expired'; orderId: string }
  | { action: 'refunded'; orderId: string }
  | { action: 'noop'; orderId: string; reason: string }
  | { action: 'unknown-order' };

export async function applyStripeEvent(
  db: WebhookDb,
  event: StripeEventLike,
  hooks: WebhookHooks = {},
): Promise<WebhookOutcome> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const order = await db.getOrderBySession(event.sessionId);
      // Unknown session: not ours (another environment's webhook secret
      // would have failed signature verification before this). Acknowledge
      // so Stripe stops retrying — there is nothing to retry INTO.
      if (!order) return { action: 'unknown-order' };
      if (order.status !== 'pending') {
        return { action: 'noop', orderId: order.id, reason: `already ${order.status}` };
      }
      await db.markPaid(order.id);
      await hooks.onPaid?.(order.id);
      return { action: 'paid', orderId: order.id };
    }

    case 'checkout.session.expired': {
      const order = await db.getOrderBySession(event.sessionId);
      if (!order) return { action: 'unknown-order' };
      // Expiry may race a completion: never downgrade a paid order.
      if (order.status !== 'pending') {
        return { action: 'noop', orderId: order.id, reason: `already ${order.status}` };
      }
      await db.markExpired(order.id);
      return { action: 'expired', orderId: order.id };
    }

    case 'charge.refunded': {
      const order = await db.getOrderById(event.orderId);
      if (!order) return { action: 'unknown-order' };
      if (order.status !== 'paid') {
        return { action: 'noop', orderId: order.id, reason: `already ${order.status}` };
      }
      await db.markRefunded(order.id);
      return { action: 'refunded', orderId: order.id };
    }
  }
}
