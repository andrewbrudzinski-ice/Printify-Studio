# Print providers

Application code never imports a provider SDK and never sees a
provider-specific ID. `PrintProvider` (`core/types.ts`) is the whole
contract; `provider_mappings` holds the ID translation; the registry
(`core/registry.ts`) picks by priority (lower number = preferred) and fails
over.

## Adding a provider (Printful, Gelato, CustomCat, ...)

1. Implement `PrintProvider` in `./printful/adapter.ts` (or similar).
   `submitOrder()` receives our order id (use it as the provider-side dedupe
   key), a shipping address, and items whose IDs are ALREADY translated —
   plus a signed URL per print file. Throw on any non-acceptance; the
   fulfilment layer records the reason and fails over or holds.
2. Add its credentials to `.env.example`.
3. Add one block to `register.ts` — an adapter registers only when its
   credentials are present. No token, no registration, and paid orders sit
   at `fulfilment_status = 'unsubmitted'`: the correct failure mode.
4. Insert `provider_mappings` rows translating each variant:

   ```sql
   insert into provider_mappings
     (variant_id, provider, provider_product_id, provider_variant_id, cost, priority)
   select id, 'printful', '<product-id>', '<variant-id>', 850, 50
   from product_variants where sku = 'MUG-11-WHT';
   ```

Nothing upstream changes. That's the entire point.

## Rules

- Any mismatch with a live provider API is a bug in that provider's adapter
  alone — NEVER a reason to change the `PrintProvider` interface.
- One provider must cover a whole order. `fulfilOrder()` holds an order that
  would need splitting across providers; per-shipment fulfilment state is a
  deliberate non-feature until a real provider forces its shape.
- Wholesale `cost` lives only in `provider_mappings`, which client roles
  cannot read (no RLS policy, no grant). Keep it that way.

## Status

- `printify/` — reference adapter, written against the documented v1 API,
  NOT yet run against the live API. Verify endpoint shapes at
  developers.printify.com before trusting it.
- `printful/`, `gelato/`, `customcat/` — not implemented. Env var names are
  reserved in `.env.example`.
