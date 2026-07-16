// Fulfilment orchestration: paid order -> print files -> provider handoff.
// Runs inline in the Stripe webhook (via the onPaid hook) and again from the
// admin retry endpoint. ~40ms render + a few hundred ms encode per item fits
// a normal basket; a 50-item order is the trigger for a background queue, not
// a reason to build one now.
//
// Every terminal state is deliberate:
//   accepted     — a provider took the order; providerOrderId recorded.
//   unsubmitted  — no adapter is registered (no token configured). Correct
//                  failure mode: visible, recoverable, no money lost.
//   error (held) — something refused on purpose. provider_response records
//                  WHICH stage, and orders.status stays 'paid': a held order
//                  is recoverable, a printed blurry canvas is not.
//
// All I/O is injected so the tests drive the real renderer and real encoders
// against every branch without a server.

import { generatePrintFile, printFormatFor } from '../print/generate';
import { isPrintQualityError, parsePrintGeometry } from '../print/geometry';
import { parseDesignSpec } from '../mockup/spec';
import type { RenderCanvas, RenderEnv, SourceImage } from '../mockup/types';
import {
  isAllProvidersFailedError,
  isNoProviderRegisteredError,
  submitWithFailover,
  type AllProvidersFailedError,
  type MappingCandidate,
  type ProviderRegistry,
} from '../providers/core/registry';
import type { ShippingAddress, SubmissionItem } from '../providers/core/types';

export interface FulfilmentItem {
  itemId: string;
  variantId: string;
  quantity: number;
  spec: unknown; // re-validated here; checkout validated it, but defence is cheap
  templateConfig: unknown;
  variantConfig: unknown | null;
  artworkPath: string; // project_images.storage_path
}

export interface FulfilmentOrder {
  id: string;
  status: string;
  fulfilmentStatus: string;
  address: ShippingAddress | null;
  items: FulfilmentItem[];
}

export interface MappingRow extends MappingCandidate {
  providerProductId: string;
  providerVariantId: string;
}

export type PrintFormat = 'png' | 'jpeg';

export interface FulfilmentDeps {
  env: RenderEnv;
  loadOrder(orderId: string): Promise<FulfilmentOrder | null>;
  loadArtwork(storagePath: string): Promise<SourceImage>;
  encode(canvas: RenderCanvas, format: PrintFormat): Promise<Uint8Array>;
  storePrintFile(orderId: string, itemIndex: number, bytes: Uint8Array, format: PrintFormat): Promise<string>;
  signPrintFile(path: string): Promise<string>;
  setItemPrintFile(itemId: string, path: string): Promise<void>;
  setFulfilment(orderId: string, status: 'submitting' | 'accepted' | 'error' | 'unsubmitted', response: unknown): Promise<void>;
  registry: ProviderRegistry;
  loadMappings(variantIds: string[]): Promise<Map<string, MappingRow[]>>;
}

export type FulfilmentOutcome =
  | { outcome: 'accepted'; providerId: string; providerOrderId: string }
  | { outcome: 'unsubmitted'; reason: string }
  | { outcome: 'held'; stage: string; reason: string }
  | { outcome: 'noop'; reason: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'not-found' };

export async function fulfilOrder(deps: FulfilmentDeps, orderId: string): Promise<FulfilmentOutcome> {
  const order = await deps.loadOrder(orderId);
  if (!order) return { outcome: 'not-found' };

  // Money guards mirror canRetry(): never manufacture what wasn't paid for,
  // never manufacture twice, never race an in-flight submission.
  if (order.status !== 'paid') {
    return { outcome: 'refused', reason: `Order is ${order.status}, not paid.` };
  }
  if (order.fulfilmentStatus === 'accepted') {
    return { outcome: 'noop', reason: 'Already accepted by a provider.' };
  }
  if (order.fulfilmentStatus === 'submitting') {
    return { outcome: 'noop', reason: 'A submission is already in flight.' };
  }
  if (!order.address) {
    await deps.setFulfilment(order.id, 'error', {
      stage: 'address',
      error: 'Order has no shipping address.',
    });
    return { outcome: 'held', stage: 'address', reason: 'no shipping address' };
  }

  await deps.setFulfilment(order.id, 'submitting', null);

  try {
    // --- Print files, one per item, positionally --------------------------
    // Generated BEFORE provider routing: a held order keeps its files, so a
    // retry after fixing mappings re-submits without re-rendering... and a
    // DPI failure holds the order before any provider hears about it.
    const printPaths: string[] = [];
    const formats: PrintFormat[] = [];
    for (let i = 0; i < order.items.length; i++) {
      const item = order.items[i]!;

      const parsed = parseDesignSpec(item.spec);
      if (!parsed.ok) {
        await deps.setFulfilment(order.id, 'error', {
          stage: 'spec',
          itemIndex: i,
          error: parsed.error,
        });
        return { outcome: 'held', stage: 'spec', reason: parsed.error };
      }

      const geometry = parsePrintGeometry(item.templateConfig, item.variantConfig ?? undefined);
      const artwork = await deps.loadArtwork(item.artworkPath);

      let render;
      try {
        render = generatePrintFile(deps.env, artwork, parsed.spec, geometry);
      } catch (e) {
        if (isPrintQualityError(e)) {
          await deps.setFulfilment(order.id, 'error', {
            stage: 'print-generation',
            itemIndex: i,
            error: (e as Error).message,
            dpi: (e as { dpi?: number }).dpi,
            minDpi: (e as { minDpi?: number }).minDpi,
          });
          return { outcome: 'held', stage: 'print-generation', reason: (e as Error).message };
        }
        throw e;
      }

      const format = printFormatFor((item.templateConfig ?? {}) as { requiresCutout?: boolean });
      const bytes = await deps.encode(render.canvas, format);
      const path = await deps.storePrintFile(order.id, i, bytes, format);
      await deps.setItemPrintFile(item.itemId, path);
      printPaths.push(path);
      formats.push(format);
    }

    // --- Provider routing ---------------------------------------------------
    const mappings = await deps.loadMappings(order.items.map((i) => i.variantId));

    const unmapped = order.items.filter((i) => (mappings.get(i.variantId) ?? []).length === 0);
    if (unmapped.length > 0) {
      await deps.setFulfilment(order.id, 'unsubmitted', {
        stage: 'provider-routing',
        error: `No provider mappings for variant(s): ${unmapped.map((i) => i.variantId).join(', ')}.`,
      });
      return { outcome: 'unsubmitted', reason: 'variant has no provider mappings' };
    }

    // One provider must cover the WHOLE order: splitting across providers
    // needs per-shipment fulfilment state, and guessing that shape before a
    // real provider is connected is how you get a migration you regret.
    let common: Set<string> | null = null;
    for (const item of order.items) {
      const providers = new Set((mappings.get(item.variantId) ?? []).map((m) => m.provider));
      if (common === null) {
        common = providers;
      } else {
        const prev: Set<string> = common;
        common = new Set([...prev].filter((p) => providers.has(p)));
      }
    }
    if (!common || common.size === 0) {
      await deps.setFulfilment(order.id, 'error', {
        stage: 'provider-routing',
        error:
          'No single provider can fulfil every item, and order splitting is not supported. ' +
          'Add mappings so one provider covers the whole order.',
      });
      return { outcome: 'held', stage: 'provider-routing', reason: 'order would need splitting' };
    }

    const candidates: MappingCandidate[] = [...common].map((provider) => ({
      provider,
      priority: Math.min(
        ...order.items.map(
          (i) => mappings.get(i.variantId)!.find((m) => m.provider === provider)!.priority,
        ),
      ),
    }));

    const address = order.address;
    try {
      const { providerId, result, failures } = await submitWithFailover(
        deps.registry,
        candidates,
        async (provider) => {
          const items: SubmissionItem[] = await Promise.all(
            order.items.map(async (item, i) => {
              const m = mappings.get(item.variantId)!.find((x) => x.provider === provider.id)!;
              return {
                providerProductId: m.providerProductId,
                providerVariantId: m.providerVariantId,
                quantity: item.quantity,
                printFileUrl: await deps.signPrintFile(printPaths[i]!),
              };
            }),
          );
          return provider.submitOrder({ externalId: order.id, address, items });
        },
      );

      await deps.setFulfilment(order.id, 'accepted', {
        provider: providerId,
        providerOrderId: result.providerOrderId,
        formats,
        failuresBeforeAccept: failures,
      });
      return { outcome: 'accepted', providerId, providerOrderId: result.providerOrderId };
    } catch (e) {
      if (isNoProviderRegisteredError(e)) {
        await deps.setFulfilment(order.id, 'unsubmitted', {
          stage: 'provider-routing',
          error: (e as Error).message,
        });
        return { outcome: 'unsubmitted', reason: (e as Error).message };
      }
      if (isAllProvidersFailedError(e)) {
        await deps.setFulfilment(order.id, 'error', {
          stage: 'provider-submission',
          failures: (e as AllProvidersFailedError).failures,
        });
        return { outcome: 'held', stage: 'provider-submission', reason: (e as Error).message };
      }
      throw e;
    }
  } catch (e) {
    // Whatever happens, the order must not be stranded at 'submitting' — an
    // unexpected crash settles to a held, retryable state with the cause.
    await deps.setFulfilment(order.id, 'error', {
      stage: 'unexpected',
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      outcome: 'held',
      stage: 'unexpected',
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
