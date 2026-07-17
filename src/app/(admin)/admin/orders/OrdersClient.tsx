'use client';

// The admin order book. Its whole reason to exist: a held order used to need
// a curl. Held and awaiting-provider orders surface with the recorded stage
// and reason (provider_response), and the Retry button drives the same
// guarded endpoint — which refuses anything canRetry() refuses.

import { useCallback, useEffect, useState } from 'react';
import { describeFulfilment, type AdminOrderRow, type FulfilmentTone } from '@/lib/admin/orders';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'unauthorised'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; orders: AdminOrderRow[] };

const TONE_CLASSES: Record<FulfilmentTone, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  info: 'bg-blue-100 text-blue-800',
  warn: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-800',
  muted: 'bg-neutral-100 text-neutral-600',
};

export default function OrdersClient() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/orders${attentionOnly ? '?filter=needs-attention' : ''}`,
    );
    if (res.status === 503) return setState({ kind: 'unconfigured' });
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return setState({ kind: 'unauthorised', message: body.error ?? 'Not authorised.' });
    }
    if (!res.ok) return setState({ kind: 'error', message: 'Could not load orders.' });
    const body = (await res.json()) as { orders: AdminOrderRow[] };
    setState({ kind: 'ready', orders: body.orders });
  }, [attentionOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(orderId: string) {
    setRetrying(orderId);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/retry`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        outcome?: { outcome: string; reason?: string; stage?: string };
        error?: string;
      };
      if (!res.ok) {
        setNotice(body.error ?? `Retry failed (HTTP ${res.status}).`);
      } else {
        const o = body.outcome;
        setNotice(
          o?.outcome === 'accepted'
            ? `Order ${orderId.slice(0, 8)}… accepted by the provider.`
            : `Retry finished: ${o?.outcome ?? 'unknown'}${o && 'reason' in o && o.reason ? ` — ${o.reason}` : ''}`,
        );
      }
      await load();
    } finally {
      setRetrying(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
        <label className="flex items-center gap-2 text-sm text-neutral-600">
          <input
            type="checkbox"
            checked={attentionOnly}
            onChange={(e) => setAttentionOnly(e.target.checked)}
          />
          Needs attention only
        </label>
      </header>

      {notice && (
        <p className="mb-4 rounded-lg bg-neutral-50 px-4 py-2 text-sm text-neutral-800">{notice}</p>
      )}

      {state.kind === 'loading' && <p className="text-neutral-500">Loading…</p>}
      {state.kind === 'unconfigured' && (
        <p className="text-neutral-600">
          Admin actions aren&apos;t configured on this deployment — connect Supabase and set the
          service role key.
        </p>
      )}
      {state.kind === 'unauthorised' && <p className="text-neutral-600">{state.message}</p>}
      {state.kind === 'error' && <p className="text-red-600">{state.message}</p>}

      {state.kind === 'ready' &&
        (state.orders.length === 0 ? (
          <p className="text-neutral-500">
            {attentionOnly ? 'Nothing needs attention.' : 'No orders yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.orders.map((order) => {
              const f = describeFulfilment(order);
              return (
                <li
                  key={order.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neutral-200 p-4"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-neutral-400">{order.id}</p>
                    <p className="text-sm">
                      <span className="font-medium">{order.email || '(no email)'}</span>
                      <span className="text-neutral-500">
                        {' '}
                        · {order.item_count} item{order.item_count === 1 ? '' : 's'} · $
                        {(order.total / 100).toFixed(2)} · {order.status}
                      </span>
                    </p>
                    {f.detail && <p className="mt-1 text-sm text-neutral-600">{f.detail}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[f.tone]}`}>
                      {f.label}
                    </span>
                    {f.canRetry && (
                      <button
                        type="button"
                        className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white transition-opacity disabled:opacity-40"
                        disabled={retrying !== null}
                        onClick={() => void retry(order.id)}
                      >
                        {retrying === order.id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ))}
    </main>
  );
}
