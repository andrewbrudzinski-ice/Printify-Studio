// Provider registry + failover. The registry holds whichever adapters
// register.ts managed to configure from the environment; submitWithFailover
// walks a variant's provider_mappings in priority order and tries each
// registered provider until one accepts.

import type { PrintProvider, SubmissionResult } from './types';

export class ProviderRegistry {
  private providers = new Map<string, PrintProvider>();

  register(provider: PrintProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): PrintProvider | null {
    return this.providers.get(id) ?? null;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  hasAny(): boolean {
    return this.providers.size > 0;
  }
}

// The app-wide registry. Tests construct their own.
export const registry = new ProviderRegistry();

// No adapter is configured at all. The webhook maps this to
// fulfilment_status = 'unsubmitted' — the correct failure mode when no token
// is set, not a bug. Distinct from AllProvidersFailedError, which is a real
// error and holds the order at 'error'.
export class NoProviderRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoProviderRegisteredError';
  }
}

export class AllProvidersFailedError extends Error {
  readonly failures: { provider: string; error: string }[];
  constructor(failures: { provider: string; error: string }[]) {
    super(
      `Every candidate provider rejected the order: ` +
        failures.map((f) => `${f.provider}: ${f.error}`).join(' | '),
    );
    this.name = 'AllProvidersFailedError';
    this.failures = failures;
  }
}

// Name checks, never instanceof — see CLAUDE.md on module-boundary identity.
export function isNoProviderRegisteredError(e: unknown): e is NoProviderRegisteredError {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NoProviderRegisteredError';
}

export function isAllProvidersFailedError(e: unknown): e is AllProvidersFailedError {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AllProvidersFailedError';
}

export interface MappingCandidate {
  provider: string;
  // LOWER value = preferred (like a queue position): a hand-tuned mapping at
  // 50 outranks the schema default of 100. Ties keep the given order.
  priority: number;
}

export async function submitWithFailover(
  reg: ProviderRegistry,
  candidates: MappingCandidate[],
  submit: (provider: PrintProvider) => Promise<SubmissionResult>,
): Promise<{ providerId: string; result: SubmissionResult; failures: { provider: string; error: string }[] }> {
  // Dedupe by provider keeping its best (lowest) priority, then sort.
  const best = new Map<string, number>();
  for (const c of candidates) {
    const existing = best.get(c.provider);
    if (existing === undefined || c.priority < existing) best.set(c.provider, c.priority);
  }
  const ordered = [...best.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([provider]) => reg.get(provider))
    .filter((p): p is PrintProvider => p !== null);

  if (ordered.length === 0) {
    throw new NoProviderRegisteredError(
      candidates.length === 0
        ? 'This variant has no provider mappings.'
        : `None of the mapped providers (${candidates.map((c) => c.provider).join(', ')}) are registered — check the API tokens.`,
    );
  }

  const failures: { provider: string; error: string }[] = [];
  for (const provider of ordered) {
    try {
      const result = await submit(provider);
      return { providerId: provider.id, result, failures };
    } catch (e) {
      failures.push({ provider: provider.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new AllProvidersFailedError(failures);
}
