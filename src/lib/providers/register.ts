// Wire configured adapters into the registry. An adapter registers ONLY if
// its credentials are present: with no token set, paid orders sit at
// fulfilment_status = 'unsubmitted' — the correct failure mode (recoverable,
// visible, no money lost), not a bug.
//
// Adding a provider: implement PrintProvider, add its env vars to
// .env.example, and add one block here. Nothing upstream changes.

import { PrintifyAdapter } from './printify/adapter';
import type { ProviderRegistry } from './core/registry';

export function registerConfiguredProviders(
  reg: ProviderRegistry,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const registered: string[] = [];

  if (env.PRINTIFY_API_TOKEN && env.PRINTIFY_SHOP_ID) {
    reg.register(
      new PrintifyAdapter({ apiToken: env.PRINTIFY_API_TOKEN, shopId: env.PRINTIFY_SHOP_ID }),
    );
    registered.push('printify');
  }

  // Printful / Gelato / CustomCat: not yet implemented. Their env vars are
  // reserved in .env.example; each is an adapter + mapping rows + a block here.

  return registered;
}
