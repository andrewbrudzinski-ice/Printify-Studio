'use client';

// The cart. Display totals run through the SAME pricing engine the server
// charges with (same bundles, same discount loader behind the validate
// endpoint), so the number on this screen and the number on the card
// statement cannot disagree. What gets POSTed to checkout is design specs,
// SKUs and quantities — never a price.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart, cartStore } from '@/stores/cart';
import { artworkStore, useArtwork, anonToken } from '@/stores/artwork';
import { priceCart } from '@/lib/pricing/engine';
import { shippingFor } from '@/lib/pricing/shipping';
import type { BundleRule, Discount } from '@/lib/pricing/types';
import type { CatalogueTemplateDto } from '@/lib/studio/grid';

export default function CartClient() {
  const items = useCart((s) => s.items);
  const uploadStatus = useArtwork((s) => s.upload.status);

  const [priceBySku, setPriceBySku] = useState<Map<string, number>>(new Map());
  const [bundles, setBundles] = useState<BundleRule[]>([]);
  const [discount, setDiscount] = useState<Discount | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [codeMessage, setCodeMessage] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/catalogue')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((body: { templates: CatalogueTemplateDto[] }) => {
        if (cancelled) return;
        const map = new Map<string, number>();
        for (const t of body.templates) for (const v of t.variants) map.set(v.sku, v.price);
        setPriceBySku(map);
      })
      .catch(() => undefined);
    void fetch('/api/bundles')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((body: { bundles: BundleRule[] }) => {
        if (!cancelled) setBundles(body.bundles);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    if (items.length === 0 || priceBySku.size === 0) return null;
    const lines = items.map((i) => ({
      sku: i.variantSku,
      unitPrice: priceBySku.get(i.variantSku) ?? 0,
      quantity: i.quantity,
    }));
    const goods = priceCart({ lines, bundles, discount });
    const count = items.reduce((sum, i) => sum + i.quantity, 0);
    const shipping = shippingFor('domestic', count, goods.taxableBase);
    return priceCart({ lines, bundles, discount, shipping });
  }, [items, priceBySku, bundles, discount]);

  async function applyCode() {
    setCodeMessage(null);
    const code = codeInput.trim();
    if (!code) return;
    const res = await fetch('/api/discount/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.status === 429) {
      setCodeMessage('Too many attempts — wait a minute.');
      return;
    }
    const body = (await res.json().catch(() => ({ valid: false }))) as {
      valid: boolean;
      code?: string;
      kind?: 'percent' | 'fixed';
      value?: number;
    };
    if (body.valid && body.code && body.kind && body.value !== undefined) {
      setDiscount({ code: body.code, kind: body.kind, value: body.value } as Discount);
      setCodeMessage(null);
    } else {
      setDiscount(null);
      setCodeMessage("That code isn't valid.");
    }
  }

  async function checkout() {
    setError(null);
    const upload = artworkStore.getState().upload;
    if (upload.status !== 'done' || !upload.imageId) {
      setError(
        upload.status === 'error'
          ? 'Your photo failed to upload. Go back to the upload page and try again.'
          : 'Your photo is still uploading — give it a few seconds and try again.',
      );
      return;
    }

    setCheckingOut(true);
    try {
      // 1. Local cart items become real design rows; ids come back in the
      //    SAME ORDER as the items were posted.
      const current = cartStore.getState().items;
      const persistRes = await fetch('/api/designs/persist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: current.map((i) => ({
            imageId: upload.imageId,
            templateSlug: i.templateSlug,
            spec: i.spec,
          })),
          anonToken: anonToken(),
        }),
      });
      if (!persistRes.ok) {
        const body = (await persistRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Could not save your designs.');
      }
      const { designIds } = (await persistRes.json()) as { designIds: string[] };

      // 2. Checkout: specs, SKUs, quantities, design ids — positionally
      //    aligned, no prices.
      const checkoutRes = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: current.map((i, idx) => ({
            templateSlug: i.templateSlug,
            variantSku: i.variantSku,
            quantity: i.quantity,
            spec: i.spec,
            designId: designIds[idx],
          })),
          email: email || undefined,
          discountCode: discount?.code,
          shippingZoneId: 'domestic',
        }),
      });
      if (!checkoutRes.ok) {
        const body = (await checkoutRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Checkout failed. Try again.');
      }
      const { url } = (await checkoutRes.json()) as { url: string };
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCheckingOut(false);
    }
  }

  if (items.length === 0) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20 text-center">
        <h1 className="text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-2 text-neutral-600">
          <Link href="/upload" className="underline">
            Upload a photo
          </Link>{' '}
          to see it on everything.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto grid max-w-4xl gap-10 px-6 py-10 lg:grid-cols-[1fr_300px]">
      <div>
        <h1 className="mb-6 text-2xl font-bold tracking-tight">Your cart</h1>
        <ul className="flex flex-col gap-4">
          {items.map((item) => (
            <li
              key={item.lineId}
              className="flex items-center justify-between gap-4 rounded-xl border border-neutral-200 p-4"
            >
              <div>
                <p className="font-medium">{item.templateSlug}</p>
                <p className="text-sm text-neutral-500">{item.variantSku}</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center rounded-lg border border-neutral-300">
                  <button
                    type="button"
                    className="px-3 py-1"
                    onClick={() => cartStore.getState().setQuantity(item.lineId, item.quantity - 1)}
                  >
                    −
                  </button>
                  <span className="min-w-8 text-center text-sm">{item.quantity}</span>
                  <button
                    type="button"
                    className="px-3 py-1"
                    onClick={() => cartStore.getState().setQuantity(item.lineId, item.quantity + 1)}
                  >
                    +
                  </button>
                </div>
                <span className="min-w-16 text-right text-sm">
                  {priceBySku.has(item.variantSku)
                    ? `$${(((priceBySku.get(item.variantSku) ?? 0) * item.quantity) / 100).toFixed(2)}`
                    : '—'}
                </span>
                <button
                  type="button"
                  className="text-sm text-neutral-400 hover:text-red-600"
                  onClick={() => cartStore.getState().removeItem(item.lineId)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <aside className="flex flex-col gap-4">
        <div className="flex gap-2">
          <input
            className="w-full rounded-lg border border-neutral-300 p-2 text-sm"
            placeholder="Discount code"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
          />
          <button
            type="button"
            className="rounded-lg border border-neutral-300 px-3 text-sm"
            onClick={() => void applyCode()}
          >
            Apply
          </button>
        </div>
        {codeMessage && <p className="text-sm text-amber-700">{codeMessage}</p>}
        {discount && (
          <p className="text-sm text-emerald-700">Code {discount.code} applied.</p>
        )}

        {totals && (
          <dl className="flex flex-col gap-1 rounded-xl bg-neutral-50 p-4 text-sm">
            <Row label="Subtotal" cents={totals.subtotal} />
            {totals.bundleDiscount > 0 && <Row label="Bundle savings" cents={-totals.bundleDiscount} />}
            {totals.codeDiscount > 0 && <Row label="Discount" cents={-totals.codeDiscount} />}
            <Row label="Shipping" cents={totals.shipping} free={totals.shipping === 0} />
            <div className="my-1 border-t border-neutral-200" />
            <Row label="Total" cents={totals.total} bold />
          </dl>
        )}

        <input
          type="email"
          className="rounded-lg border border-neutral-300 p-2 text-sm"
          placeholder="Email for your receipt"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <button
          type="button"
          className="rounded-xl bg-neutral-900 px-6 py-3 font-medium text-white transition-opacity disabled:opacity-40"
          disabled={checkingOut}
          onClick={() => void checkout()}
        >
          {checkingOut ? 'Preparing checkout…' : 'Checkout'}
        </button>
        {uploadStatus === 'uploading' && (
          <p className="text-xs text-neutral-500">Your photo is still uploading in the background.</p>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </aside>
    </main>
  );
}

function Row({
  label,
  cents,
  bold,
  free,
}: {
  label: string;
  cents: number;
  bold?: boolean;
  free?: boolean;
}) {
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold' : ''}`}>
      <dt>{label}</dt>
      <dd>{free ? 'Free' : `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`}</dd>
    </div>
  );
}
