// Fulfilment state rules — pure, so the webhook and the admin retry endpoint
// share one truth about what a state means and which transitions are legal.
//
// orders.status tracks money; orders.fulfilment_status tracks manufacturing.
// They are separate on purpose: a paid order held at 'error' has lost no
// money and is recoverable. A printed mistake is not.

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'expired';
export type FulfilmentStatus = 'unsubmitted' | 'submitting' | 'accepted' | 'error';

export type RetryDecision = { ok: true } | { ok: false; reason: string };

// The retry guard. POST /api/admin/orders/[id]/retry consults this and
// nothing else, so the reasons here are the API's responses verbatim.
export function canRetry(order: {
  status: string;
  fulfilment_status: string;
}): RetryDecision {
  if (order.status !== 'paid') {
    return {
      ok: false,
      reason: `Order is ${order.status}, not paid — retrying would ship it for free.`,
    };
  }
  switch (order.fulfilment_status as FulfilmentStatus) {
    case 'accepted':
      return { ok: false, reason: 'Order was already accepted by a provider — retrying would ship it twice.' };
    case 'submitting':
      return { ok: false, reason: 'A submission is already in flight — wait for it to settle.' };
    case 'unsubmitted':
    case 'error':
      return { ok: true };
    default:
      return { ok: false, reason: `Unknown fulfilment status "${order.fulfilment_status}".` };
  }
}
