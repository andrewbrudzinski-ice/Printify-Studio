// The whole provider contract. Application code never imports a provider SDK
// and never sees a provider-specific ID: provider_mappings translates our
// variant IDs into (provider_product_id, provider_variant_id), and everything
// upstream talks only to this interface. Adding a provider = implement this +
// insert mapping rows + one line in register.ts. Nothing upstream changes.
//
// Any mismatch with a real provider's API is a bug in that provider's adapter
// alone — NEVER a reason to change this interface.

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface SubmissionItem {
  // Provider-side IDs, already translated via provider_mappings.
  providerProductId: string;
  providerVariantId: string;
  quantity: number;
  // Signed URL to the generated print file in the private `prints` bucket.
  printFileUrl: string;
}

export interface ProviderOrder {
  // Our order ID — the idempotency handle on the provider side.
  externalId: string;
  address: ShippingAddress;
  items: SubmissionItem[];
}

export interface SubmissionResult {
  providerOrderId: string;
  // The provider's raw response, persisted to orders.provider_response so a
  // held order can say which stage failed.
  raw?: unknown;
}

export interface PrintProvider {
  readonly id: string;
  submitOrder(order: ProviderOrder): Promise<SubmissionResult>;
}
