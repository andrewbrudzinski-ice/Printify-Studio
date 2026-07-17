// Admin order presentation — pure, so the "what does this state mean and
// what can I do about it" logic is tested once and the UI just renders it.
//
// The vocabulary matters: 'unsubmitted' and 'error' are DELIBERATE states
// (see CLAUDE.md), and the dashboard must present them as situations with a
// next step, not as generic failures.

import { canRetry } from '../fulfilment/rules';

export interface AdminOrderRow {
  id: string;
  email: string;
  status: string;
  fulfilment_status: string;
  total: number;
  created_at: string;
  provider_response: unknown;
  item_count: number;
}

export type FulfilmentTone = 'ok' | 'info' | 'warn' | 'error' | 'muted';

export interface FulfilmentPresentation {
  label: string;
  tone: FulfilmentTone;
  detail: string | null;
  canRetry: boolean;
}

interface ProviderResponseShape {
  stage?: string;
  error?: string;
  provider?: string;
  providerOrderId?: string;
  failures?: Array<{ provider?: string; error?: string }>;
}

export function describeFulfilment(order: {
  status: string;
  fulfilment_status: string;
  provider_response: unknown;
}): FulfilmentPresentation {
  const response = (order.provider_response ?? {}) as ProviderResponseShape;
  const retry = canRetry(order).ok;

  switch (order.fulfilment_status) {
    case 'accepted':
      return {
        label: 'Accepted',
        tone: 'ok',
        detail: response.provider
          ? `${response.provider} order ${response.providerOrderId ?? '?'}`
          : null,
        canRetry: false,
      };

    case 'submitting':
      return { label: 'Submitting…', tone: 'info', detail: null, canRetry: false };

    case 'unsubmitted':
      if (order.status !== 'paid') {
        // Nothing is wrong: money hasn't arrived, so nothing should ship.
        return { label: 'Awaiting payment', tone: 'muted', detail: null, canRetry: false };
      }
      return {
        label: 'Awaiting provider',
        tone: 'warn',
        detail:
          response.error ??
          'No print provider is registered — set a provider API token and retry.',
        canRetry: retry,
      };

    case 'error': {
      const stage = response.stage ?? 'unknown';
      let detail = response.error ?? null;
      if (!detail && response.failures?.length) {
        detail = response.failures
          .map((f) => `${f.provider ?? '?'}: ${f.error ?? '?'}`)
          .join(' | ');
      }
      return {
        label: `Held: ${stage}`,
        tone: 'error',
        detail,
        canRetry: retry,
      };
    }

    default:
      return {
        label: order.fulfilment_status,
        tone: 'muted',
        detail: null,
        canRetry: false,
      };
  }
}
