// DesignSpec validation, field by field. This is the boundary where a spec
// crosses from the client into a jsonb column at checkout.
//
// It was once z.record(z.unknown()): that typechecked as "some object" but
// wasn't provably JSON-serialisable, and casting it into jsonb let malformed
// specs reach the print pipeline — failing at render time, AFTER payment.
// Field-by-field is the fix, and tests/spec.test.mts asserts the schema
// accepts exactly what DEFAULT_SPEC and applyPatch produce. If those drift,
// checkout 400s on the address screen — the worst place to find out.

import { z } from 'zod';
import { DEFAULT_SPEC, type DesignSpec } from './types';

// The numeric bounds for a valid spec — ONE definition. The editor's clamps
// (src/stores/editor.ts) import these, so a value the editor can produce is
// always a value this schema accepts. The schema still validates
// independently: the server never trusts that a spec came through the editor.
export const SPEC_LIMITS = {
  scale: [1, 8],
  pan: [-1, 1],
  brightness: [0.2, 2],
  contrast: [0.2, 2],
  saturation: [0, 2],
} as const;

// .strict() everywhere: unknown keys are rejected, not silently carried into
// the database. .finite() everywhere: JSON has no NaN/Infinity, and a spec
// must survive a JSON round-trip byte-for-byte.
export const designSpecSchema = z
  .object({
    version: z.literal(1),
    transform: z
      .object({
        x: z.number().finite().min(SPEC_LIMITS.pan[0]).max(SPEC_LIMITS.pan[1]),
        y: z.number().finite().min(SPEC_LIMITS.pan[0]).max(SPEC_LIMITS.pan[1]),
        scale: z.number().finite().min(SPEC_LIMITS.scale[0]).max(SPEC_LIMITS.scale[1]),
        // applyPatch normalises rotation into [-180, 180).
        rotation: z.number().finite().gte(-180).lt(180),
      })
      .strict(),
    filters: z
      .object({
        brightness: z.number().finite().min(SPEC_LIMITS.brightness[0]).max(SPEC_LIMITS.brightness[1]),
        contrast: z.number().finite().min(SPEC_LIMITS.contrast[0]).max(SPEC_LIMITS.contrast[1]),
        saturation: z.number().finite().min(SPEC_LIMITS.saturation[0]).max(SPEC_LIMITS.saturation[1]),
      })
      .strict(),
  })
  .strict();

// Compile-time drift guards, both directions: if the schema and the
// DesignSpec type disagree, this module stops typechecking.
type SchemaSpec = z.infer<typeof designSpecSchema>;
const _defaultSatisfiesSchema: SchemaSpec = DEFAULT_SPEC;
const _schemaSatisfiesType: DesignSpec = {} as SchemaSpec;
void _defaultSatisfiesSchema;
void _schemaSatisfiesType;

export type SpecParseResult =
  | { ok: true; spec: DesignSpec }
  | { ok: false; error: string };

// Route-friendly: never throws, and the error names the offending field so a
// 400 can say something actionable.
export function parseDesignSpec(input: unknown): SpecParseResult {
  const result = designSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  const first = result.error.issues[0];
  const path = first?.path.join('.') || 'spec';
  return { ok: false, error: `Invalid design spec at "${path}": ${first?.message ?? 'unknown error'}` };
}
