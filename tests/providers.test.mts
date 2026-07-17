// Provider registry, failover, the Printify adapter's request mapping, and
// the fulfilment retry guard. The adapter test asserts the exact HTTP call —
// the adapter itself is unverified against the live API, so pinning what it
// SENDS is the strongest claim available without a token.
import assert from 'node:assert/strict';
import {
  AllProvidersFailedError,
  isAllProvidersFailedError,
  isNoProviderRegisteredError,
  ProviderRegistry,
  submitWithFailover,
} from '../src/lib/providers/core/registry';
import { PrintifyAdapter } from '../src/lib/providers/printify/adapter';
import { registerConfiguredProviders } from '../src/lib/providers/register';
import { canRetry } from '../src/lib/fulfilment/rules';
import type { PrintProvider, ProviderOrder, SubmissionResult } from '../src/lib/providers/core/types';

let count = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    count += 1;
    console.log(`  ok  ${label}`);
  });
}

function fakeProvider(id: string, behaviour: 'ok' | 'fail'): PrintProvider {
  return {
    id,
    async submitOrder(): Promise<SubmissionResult> {
      if (behaviour === 'fail') throw new Error(`${id} says no`);
      return { providerOrderId: `${id}-123` };
    },
  };
}

const ORDER: ProviderOrder = {
  externalId: 'ord_1',
  address: {
    name: 'Ada Lovelace',
    line1: '1 Analytical Way',
    city: 'London',
    postalCode: 'N1 7AA',
    country: 'GB',
  },
  items: [
    { providerProductId: 'bp-77', providerVariantId: '4012', quantity: 2, printFileUrl: 'https://signed/print1.png' },
  ],
};

// --- Registry ----------------------------------------------------------------

await check('register/get/ids round-trip; duplicate registration throws', () => {
  const reg = new ProviderRegistry();
  const p = fakeProvider('printify', 'ok');
  reg.register(p);
  assert.equal(reg.get('printify'), p);
  assert.deepEqual(reg.ids(), ['printify']);
  assert.throws(() => reg.register(fakeProvider('printify', 'ok')), /already registered/);
});

await check('registerConfiguredProviders: no token, no adapter — the unsubmitted driver', () => {
  const reg = new ProviderRegistry();
  const registered = registerConfiguredProviders(reg, {});
  assert.deepEqual(registered, []);
  assert.equal(reg.hasAny(), false);
});

await check('registerConfiguredProviders: token + shop registers printify', () => {
  const reg = new ProviderRegistry();
  const registered = registerConfiguredProviders(reg, {
    PRINTIFY_API_TOKEN: 'tok',
    PRINTIFY_SHOP_ID: 'shop1',
  });
  assert.deepEqual(registered, ['printify']);
  assert.ok(reg.get('printify'));
});

// --- Failover -----------------------------------------------------------------

await check('failover: lower priority number is tried first and wins', async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider('gelato', 'ok'));
  reg.register(fakeProvider('printify', 'ok'));
  const { providerId, failures } = await submitWithFailover(
    reg,
    [
      { provider: 'gelato', priority: 100 },
      { provider: 'printify', priority: 50 },
    ],
    (p) => p.submitOrder(ORDER),
  );
  assert.equal(providerId, 'printify');
  assert.deepEqual(failures, []);
});

await check('failover: first provider fails, second succeeds, failure recorded', async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider('printify', 'fail'));
  reg.register(fakeProvider('gelato', 'ok'));
  const { providerId, result, failures } = await submitWithFailover(
    reg,
    [
      { provider: 'printify', priority: 50 },
      { provider: 'gelato', priority: 100 },
    ],
    (p) => p.submitOrder(ORDER),
  );
  assert.equal(providerId, 'gelato');
  assert.equal(result.providerOrderId, 'gelato-123');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.provider, 'printify');
});

await check('failover: every provider fails → AllProvidersFailedError with each reason', async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider('printify', 'fail'));
  reg.register(fakeProvider('gelato', 'fail'));
  await assert.rejects(
    submitWithFailover(
      reg,
      [
        { provider: 'printify', priority: 50 },
        { provider: 'gelato', priority: 100 },
      ],
      (p) => p.submitOrder(ORDER),
    ),
    (e: unknown) => {
      assert.ok(isAllProvidersFailedError(e));
      assert.equal((e as AllProvidersFailedError).failures.length, 2);
      assert.match((e as Error).message, /printify says no/);
      assert.match((e as Error).message, /gelato says no/);
      return true;
    },
  );
});

await check('failover: mappings exist but none registered → NoProviderRegisteredError', async () => {
  const reg = new ProviderRegistry();
  await assert.rejects(
    submitWithFailover(reg, [{ provider: 'printify', priority: 50 }], (p) => p.submitOrder(ORDER)),
    (e: unknown) => isNoProviderRegisteredError(e),
  );
});

await check('failover: no mappings at all is also NoProviderRegisteredError, different message', async () => {
  const reg = new ProviderRegistry();
  reg.register(fakeProvider('printify', 'ok'));
  await assert.rejects(
    submitWithFailover(reg, [], (p) => p.submitOrder(ORDER)),
    /no provider mappings/,
  );
});

await check('failover: duplicate candidates collapse to one attempt at best priority', async () => {
  const reg = new ProviderRegistry();
  let calls = 0;
  reg.register({
    id: 'printify',
    async submitOrder() {
      calls++;
      throw new Error('nope');
    },
  });
  reg.register(fakeProvider('gelato', 'ok'));
  const { providerId } = await submitWithFailover(
    reg,
    [
      { provider: 'printify', priority: 90 },
      { provider: 'printify', priority: 10 },
      { provider: 'gelato', priority: 50 },
    ],
    (p) => p.submitOrder(ORDER),
  );
  // printify's best priority (10) beats gelato (50), so it goes first — once.
  assert.equal(calls, 1);
  assert.equal(providerId, 'gelato');
});

// --- Printify adapter request mapping -------------------------------------------

await check('adapter sends the documented v1 request: URL, auth, body mapping', async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl = (async (url: any, init: any) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(JSON.stringify({ id: 987654 }), { status: 200 });
  }) as typeof fetch;

  const adapter = new PrintifyAdapter({ apiToken: 'tok-abc', shopId: 'shop-9', fetchImpl });
  const result = await adapter.submitOrder(ORDER);

  assert.equal(result.providerOrderId, '987654', 'numeric id returned as string');
  assert.equal(captured.url, 'https://api.printify.com/v1/shops/shop-9/orders.json');
  assert.equal(captured.init!.method, 'POST');
  const headers = captured.init!.headers as Record<string, string>;
  assert.equal(headers['Authorization'], 'Bearer tok-abc');
  assert.equal(headers['Content-Type'], 'application/json');

  const body = JSON.parse(String(captured.init!.body));
  assert.equal(body.external_id, 'ord_1', 'our order id is the provider-side dedupe key');
  assert.equal(body.line_items.length, 1);
  assert.deepEqual(body.line_items[0], {
    product_id: 'bp-77',
    variant_id: 4012,
    quantity: 2,
    print_areas: { front: 'https://signed/print1.png' },
  });
  assert.equal(body.address_to.first_name, 'Ada');
  assert.equal(body.address_to.last_name, 'Lovelace');
  assert.equal(body.address_to.country, 'GB');
});

await check('adapter surfaces a non-2xx response with status and body', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"invalid variant"}', { status: 422 })) as typeof fetch;
  const adapter = new PrintifyAdapter({ apiToken: 't', shopId: 's', fetchImpl });
  await assert.rejects(adapter.submitOrder(ORDER), /HTTP 422.*invalid variant/s);
});

await check('adapter refuses a 200 with no order id — silent acceptance is not acceptance', async () => {
  const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  const adapter = new PrintifyAdapter({ apiToken: 't', shopId: 's', fetchImpl });
  await assert.rejects(adapter.submitOrder(ORDER), /no order ID/);
});

await check('adapter constructor rejects missing credentials', () => {
  assert.throws(() => new PrintifyAdapter({ apiToken: '', shopId: 's' }), /token/);
});

// --- Retry guard -------------------------------------------------------------------

await check('retry guard: paid + error/unsubmitted may retry; everything else refuses', () => {
  assert.equal(canRetry({ status: 'paid', fulfilment_status: 'error' }).ok, true);
  assert.equal(canRetry({ status: 'paid', fulfilment_status: 'unsubmitted' }).ok, true);

  const unpaid = canRetry({ status: 'pending', fulfilment_status: 'error' });
  assert.equal(unpaid.ok, false);
  assert.match((unpaid as { reason: string }).reason, /ship it for free/);

  const accepted = canRetry({ status: 'paid', fulfilment_status: 'accepted' });
  assert.equal(accepted.ok, false);
  assert.match((accepted as { reason: string }).reason, /ship it twice/);

  const inflight = canRetry({ status: 'paid', fulfilment_status: 'submitting' });
  assert.equal(inflight.ok, false);

  const refunded = canRetry({ status: 'refunded', fulfilment_status: 'error' });
  assert.equal(refunded.ok, false);
});

console.log(`\n${count} checks passed.`);
