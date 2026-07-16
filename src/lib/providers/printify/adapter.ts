// Printify adapter — the reference PrintProvider implementation.
//
// UNVERIFIED AGAINST THE LIVE API. This is written against the documented v1
// API (developers.printify.com) in an environment that couldn't call it.
// Verify the endpoint shapes before trusting it in production. Any mismatch
// is a bug in THIS file alone — never a reason to change the PrintProvider
// interface.

import type { PrintProvider, ProviderOrder, ShippingAddress, SubmissionResult } from '../core/types';

export interface PrintifyConfig {
  apiToken: string;
  shopId: string;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.printify.com';

export class PrintifyAdapter implements PrintProvider {
  readonly id = 'printify';
  private readonly cfg: Required<Pick<PrintifyConfig, 'apiToken' | 'shopId'>> & PrintifyConfig;

  constructor(cfg: PrintifyConfig) {
    if (!cfg.apiToken || !cfg.shopId) {
      throw new Error('PrintifyAdapter needs both an API token and a shop ID.');
    }
    this.cfg = cfg;
  }

  async submitOrder(order: ProviderOrder): Promise<SubmissionResult> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.baseUrl ?? DEFAULT_BASE_URL;

    const body = {
      // Printify treats external_id as the dedupe key: replaying the same
      // order (a retried webhook) must not manufacture twice.
      external_id: order.externalId,
      label: `printify-studio ${order.externalId}`,
      line_items: order.items.map((i) => ({
        product_id: i.providerProductId,
        variant_id: Number(i.providerVariantId),
        quantity: i.quantity,
        print_areas: { front: i.printFileUrl },
      })),
      shipping_method: 1,
      send_shipping_notification: false,
      address_to: toPrintifyAddress(order.address),
    };

    const res = await doFetch(`${base}/v1/shops/${this.cfg.shopId}/orders.json`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Printify rejected the order (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }

    const json = (await res.json()) as { id?: string | number };
    if (json.id === undefined || json.id === null) {
      throw new Error('Printify accepted the order but returned no order ID.');
    }
    return { providerOrderId: String(json.id), raw: json };
  }
}

function toPrintifyAddress(a: ShippingAddress) {
  // Printify wants first/last split; we store one name field. Splitting on
  // the last space is imperfect for multi-word surnames but only affects the
  // shipping label, and the alternative (two form fields) hurts the funnel.
  const idx = a.name.lastIndexOf(' ');
  const first = idx > 0 ? a.name.slice(0, idx) : a.name;
  const last = idx > 0 ? a.name.slice(idx + 1) : '';
  return {
    first_name: first,
    last_name: last,
    address1: a.line1,
    address2: a.line2 ?? '',
    city: a.city,
    region: a.state ?? '',
    zip: a.postalCode,
    country: a.country,
  };
}
