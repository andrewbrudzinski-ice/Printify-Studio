// The fulfilment orchestration, every branch, with the REAL renderer and
// REAL encoders behind fake I/O: print bytes are actual JPEG/PNG (verified by
// magic numbers), DPI holds come from the actual gate, and provider handoff
// runs through the actual registry.
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { fulfilOrder } from '../src/lib/fulfilment/submit';
import type { FulfilmentDeps, FulfilmentOrder, MappingRow } from '../src/lib/fulfilment/submit';
import { ProviderRegistry } from '../src/lib/providers/core/registry';
import type { PrintProvider, ProviderOrder } from '../src/lib/providers/core/types';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { RenderCanvas } from '../src/lib/mockup/types';

let count = 0;
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

// --- Fixtures --------------------------------------------------------------------

const PLAIN_CONFIG = {
  print: { widthIn: 4, heightIn: 4, bleedIn: 0.125, safeIn: 0.125, minDpi: 100 },
  requiresCutout: false,
};
const CUTOUT_CONFIG = {
  print: { widthIn: 2, heightIn: 2, bleedIn: 0.0625, safeIn: 0.0625, minDpi: 100 },
  requiresCutout: true,
};

function photo(w: number, h: number, seed = 0): RenderCanvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i + seed * 37) % 251;
    img.data[i + 1] = (i * 2 + seed * 91) % 241;
    img.data[i + 2] = (i * 3 + seed * 53) % 233;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c as unknown as RenderCanvas;
}

const ADDRESS = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Way',
  city: 'London',
  postalCode: 'N1 7AA',
  country: 'GB',
};

interface HarnessOptions {
  order?: Partial<FulfilmentOrder>;
  artworks?: Record<string, RenderCanvas>;
  mappings?: Record<string, MappingRow[]>;
  providers?: PrintProvider[];
}

// A deps harness that records everything fulfilOrder does.
function harness(opts: HarnessOptions = {}) {
  const order: FulfilmentOrder = {
    id: 'ord-1',
    status: 'paid',
    fulfilmentStatus: 'unsubmitted',
    address: ADDRESS,
    items: [
      {
        itemId: 'item-1',
        variantId: 'var-mug',
        quantity: 1,
        spec: structuredClone(DEFAULT_SPEC),
        templateConfig: PLAIN_CONFIG,
        variantConfig: null,
        artworkPath: 'u/photo-a.jpg',
      },
    ],
    ...opts.order,
  };

  const artworks = opts.artworks ?? { 'u/photo-a.jpg': photo(1500, 1500, 1) };
  const mappings =
    opts.mappings ?? ({
      'var-mug': [
        { provider: 'printify', priority: 50, providerProductId: 'bp-77', providerVariantId: '4012' },
      ],
    } as Record<string, MappingRow[]>);

  const registry = new ProviderRegistry();
  for (const p of opts.providers ?? [acceptingProvider()]) registry.register(p);

  const stored: Record<string, Uint8Array> = {};
  const itemFiles: Record<string, string> = {};
  const fulfilmentLog: Array<{ status: string; response: unknown }> = [];
  const artworkLoads: string[] = [];
  const submissions: ProviderOrder[] = [];

  const deps: FulfilmentDeps = {
    env: {
      createCanvas: (w, h) => createCanvas(w, h) as unknown as RenderCanvas,
      loadAsset: async (src) => {
        throw new Error(`no assets in print generation: ${src}`);
      },
    },
    loadOrder: async (id) => (id === order.id ? structuredClone(order) : null),
    loadArtwork: async (path) => {
      artworkLoads.push(path);
      const a = artworks[path];
      if (!a) throw new Error(`missing artwork ${path}`);
      return a;
    },
    encode: async (canvas, format) => {
      const c = canvas as unknown as import('@napi-rs/canvas').Canvas;
      return format === 'jpeg' ? c.encode('jpeg', 92) : c.encode('png');
    },
    storePrintFile: async (orderId, i, bytes, format) => {
      const path = `${orderId}/item-${i}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      stored[path] = bytes;
      return path;
    },
    signPrintFile: async (path) => `https://signed.example/${path}`,
    setItemPrintFile: async (itemId, path) => {
      itemFiles[itemId] = path;
    },
    setFulfilment: async (_orderId, status, response) => {
      fulfilmentLog.push({ status, response });
    },
    registry,
    loadMappings: async () => new Map(Object.entries(mappings)),
  };

  return { deps, order, stored, itemFiles, fulfilmentLog, artworkLoads, submissions };

  function acceptingProvider(): PrintProvider {
    return {
      id: 'printify',
      async submitOrder(o) {
        submissions.push(o);
        return { providerOrderId: 'pfy-123' };
      },
    };
  }
}

// --- The happy path ------------------------------------------------------------------

await check('a paid order renders, encodes, stores, submits, and lands accepted', async () => {
  const h = harness();
  const result = await fulfilOrder(h.deps, 'ord-1');

  assert.deepEqual(result, { outcome: 'accepted', providerId: 'printify', providerOrderId: 'pfy-123' });

  // Real JPEG came out of the real encoder (magic bytes FF D8).
  const bytes = h.stored['ord-1/item-0.jpg']!;
  assert.ok(bytes.length > 5_000, `print file suspiciously small: ${bytes.length} bytes`);
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);

  // The item points at its file; the provider got a signed URL to it.
  assert.equal(h.itemFiles['item-1'], 'ord-1/item-0.jpg');
  assert.equal(h.submissions[0]!.items[0]!.printFileUrl, 'https://signed.example/ord-1/item-0.jpg');
  assert.equal(h.submissions[0]!.externalId, 'ord-1');

  // State walked submitting -> accepted, with the provider order recorded.
  assert.deepEqual(h.fulfilmentLog.map((f) => f.status), ['submitting', 'accepted']);
  const final = h.fulfilmentLog[1]!.response as { providerOrderId: string };
  assert.equal(final.providerOrderId, 'pfy-123');
});

await check('a die-cut product encodes PNG (alpha), a photo product JPEG — from data', async () => {
  const h = harness({
    order: {
      items: [
        { itemId: 'i1', variantId: 'var-mug', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: PLAIN_CONFIG, variantConfig: null, artworkPath: 'u/photo-a.jpg' },
        { itemId: 'i2', variantId: 'var-key', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: CUTOUT_CONFIG, variantConfig: null, artworkPath: 'u/photo-a.jpg' },
      ],
    },
    mappings: {
      'var-mug': [{ provider: 'printify', priority: 50, providerProductId: 'bp-77', providerVariantId: '1' }],
      'var-key': [{ provider: 'printify', priority: 50, providerProductId: 'bp-88', providerVariantId: '2' }],
    },
  });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'accepted');

  const jpeg = h.stored['ord-1/item-0.jpg']!;
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  const png = h.stored['ord-1/item-1.png']!;
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50); // 'P'
});

await check('two same-SKU items with different photos produce two different print files', async () => {
  const h = harness({
    order: {
      items: [
        { itemId: 'i1', variantId: 'var-mug', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: PLAIN_CONFIG, variantConfig: null, artworkPath: 'u/dog.jpg' },
        { itemId: 'i2', variantId: 'var-mug', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: PLAIN_CONFIG, variantConfig: null, artworkPath: 'u/cat.jpg' },
      ],
    },
    artworks: { 'u/dog.jpg': photo(1500, 1500, 1), 'u/cat.jpg': photo(1500, 1500, 99) },
  });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(h.artworkLoads, ['u/dog.jpg', 'u/cat.jpg'], 'each item loads ITS OWN photo');
  assert.equal(h.itemFiles['i1'], 'ord-1/item-0.jpg');
  assert.equal(h.itemFiles['i2'], 'ord-1/item-1.jpg');
  const a = h.stored['ord-1/item-0.jpg']!;
  const b = h.stored['ord-1/item-1.jpg']!;
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b), 'the two print files must differ');
});

// --- Money guards ---------------------------------------------------------------------

await check('an unpaid order is refused before anything renders or ships', async () => {
  const h = harness({ order: { status: 'pending' } });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'refused');
  assert.deepEqual(h.fulfilmentLog, [], 'no state was touched');
  assert.deepEqual(h.submissions, []);
});

await check('an accepted order is a no-op — nothing ships twice', async () => {
  const h = harness({ order: { fulfilmentStatus: 'accepted' } });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(h.submissions, []);
});

await check('an in-flight submission is not raced', async () => {
  const h = harness({ order: { fulfilmentStatus: 'submitting' } });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'noop');
  assert.deepEqual(h.fulfilmentLog, []);
});

// --- Holds -------------------------------------------------------------------------------

await check('bad art holds the order BEFORE any provider hears about it', async () => {
  const h = harness({ artworks: { 'u/photo-a.jpg': photo(300, 300) } }); // ~70 DPI on 4.25in
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'held');
  assert.equal((result as { stage: string }).stage, 'print-generation');
  assert.deepEqual(h.submissions, [], 'the provider must never see a bad order');

  const held = h.fulfilmentLog.at(-1)!;
  assert.equal(held.status, 'error');
  const resp = held.response as { stage: string; error: string; dpi: number; minDpi: number };
  assert.equal(resp.stage, 'print-generation');
  assert.match(resp.error, /higher-resolution photo/);
  assert.ok(resp.dpi < resp.minDpi);
});

await check('a missing shipping address holds with its own stage', async () => {
  const h = harness({ order: { address: null } });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'held');
  assert.equal((result as { stage: string }).stage, 'address');
});

await check('no provider registered → back to unsubmitted, print files kept for retry', async () => {
  const h = harness({ providers: [] });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'unsubmitted');
  assert.ok(h.stored['ord-1/item-0.jpg'], 'the render is not wasted — retry reuses it');
  assert.equal(h.fulfilmentLog.at(-1)!.status, 'unsubmitted');
});

await check('a variant with no mappings at all → unsubmitted with the variant named', async () => {
  const h = harness({ mappings: { 'var-mug': [] } });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'unsubmitted');
  const resp = h.fulfilmentLog.at(-1)!.response as { error: string };
  assert.match(resp.error, /var-mug/);
});

await check('every provider failing holds the order with each reason recorded', async () => {
  const failing: PrintProvider = {
    id: 'printify',
    async submitOrder() {
      throw new Error('shop suspended');
    },
  };
  const h = harness({ providers: [failing] });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'held');
  assert.equal((result as { stage: string }).stage, 'provider-submission');
  const resp = h.fulfilmentLog.at(-1)!.response as { failures: Array<{ provider: string; error: string }> };
  assert.equal(resp.failures[0]!.provider, 'printify');
  assert.match(resp.failures[0]!.error, /shop suspended/);
});

await check('an order needing two providers is held — splitting is deliberately unsupported', async () => {
  const h = harness({
    order: {
      items: [
        { itemId: 'i1', variantId: 'var-a', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: PLAIN_CONFIG, variantConfig: null, artworkPath: 'u/photo-a.jpg' },
        { itemId: 'i2', variantId: 'var-b', quantity: 1, spec: structuredClone(DEFAULT_SPEC), templateConfig: PLAIN_CONFIG, variantConfig: null, artworkPath: 'u/photo-a.jpg' },
      ],
    },
    mappings: {
      'var-a': [{ provider: 'printify', priority: 50, providerProductId: 'p', providerVariantId: '1' }],
      'var-b': [{ provider: 'gelato', priority: 50, providerProductId: 'g', providerVariantId: '2' }],
    },
  });
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'held');
  assert.equal((result as { stage: string }).stage, 'provider-routing');
  const resp = h.fulfilmentLog.at(-1)!.response as { error: string };
  assert.match(resp.error, /splitting is not supported/);
});

await check('an unexpected crash settles to a held, retryable state — never stranded at submitting', async () => {
  const h = harness();
  h.deps.storePrintFile = async () => {
    throw new Error('storage exploded');
  };
  const result = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(result.outcome, 'held');
  assert.equal((result as { stage: string }).stage, 'unexpected');
  const last = h.fulfilmentLog.at(-1)!;
  assert.equal(last.status, 'error');
  assert.match((last.response as { error: string }).error, /storage exploded/);
});

await check('retry after a provider failure succeeds once the provider recovers', async () => {
  let attempts = 0;
  const flaky: PrintProvider = {
    id: 'printify',
    async submitOrder() {
      attempts++;
      if (attempts === 1) throw new Error('temporarily unavailable');
      return { providerOrderId: 'pfy-999' };
    },
  };
  const h = harness({ providers: [flaky] });

  const first = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(first.outcome, 'held');

  // The admin retries (the DB row would now read paid + error, which
  // canRetry permits — asserted in tests/providers.test.mts).
  const second = await fulfilOrder(h.deps, 'ord-1');
  assert.equal(second.outcome, 'accepted');
  assert.equal((second as { providerOrderId: string }).providerOrderId, 'pfy-999');
});

console.log(`\n${count} checks passed through the real renderer and encoders.`);
