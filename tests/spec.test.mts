// The spec schema is the gate between the client and the jsonb column. Two
// invariants: it accepts EVERYTHING the editor can produce (or checkout 400s
// on the address screen for a legitimate customer), and it rejects everything
// else (or malformed specs reach the print pipeline and fail after payment).
import assert from 'node:assert/strict';
import { designSpecSchema, parseDesignSpec } from '../src/lib/mockup/spec';
import { applyPatch } from '../src/stores/editor';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { DesignSpec } from '../src/lib/mockup/types';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

check('the schema accepts exactly what DEFAULT_SPEC produces', () => {
  const parsed = designSpecSchema.parse(DEFAULT_SPEC);
  assert.deepEqual(parsed, DEFAULT_SPEC);
});

check('the schema accepts everything applyPatch can produce — 500-case fuzz', () => {
  // Nasty inputs by design: the editor clamps/ignores them, so whatever comes
  // OUT of applyPatch must always validate. If this fails, the editor and the
  // schema have drifted apart — the exact bug this test exists to catch.
  const nasty = [NaN, Infinity, -Infinity, -1e9, -5, -1, -0.3, 0, 0.5, 1, 1.7, 2, 7.9, 8, 9, 181, 360.5, 1e9];
  const pick = () => nasty[Math.floor(Math.random() * nasty.length)]!;
  let spec: DesignSpec = DEFAULT_SPEC;
  for (let i = 0; i < 500; i++) {
    spec = applyPatch(spec, {
      transform: {
        ...(Math.random() < 0.7 ? { x: pick() } : {}),
        ...(Math.random() < 0.7 ? { y: pick() } : {}),
        ...(Math.random() < 0.7 ? { scale: pick() } : {}),
        ...(Math.random() < 0.7 ? { rotation: pick() } : {}),
      },
      filters: {
        ...(Math.random() < 0.5 ? { brightness: pick() } : {}),
        ...(Math.random() < 0.5 ? { contrast: pick() } : {}),
        ...(Math.random() < 0.5 ? { saturation: pick() } : {}),
      },
    });
    const result = designSpecSchema.safeParse(spec);
    assert.ok(result.success, `iteration ${i}: ${JSON.stringify(spec)} rejected`);
  }
});

check('a JSON round-trip of an edited spec still validates', () => {
  const spec = applyPatch(DEFAULT_SPEC, {
    transform: { x: 0.31, scale: 2.5, rotation: -12 },
    filters: { contrast: 1.2 },
  });
  const parsed = designSpecSchema.parse(JSON.parse(JSON.stringify(spec)));
  assert.deepEqual(parsed, spec);
});

check('rejects zoom below cover-fit — the server never trusts client clamps', () => {
  const bad = structuredClone(DEFAULT_SPEC) as { transform: { scale: number } };
  bad.transform.scale = 0.5; // would print blank edges
  assert.equal(designSpecSchema.safeParse(bad).success, false);
});

check('rejects unknown keys at the root and nested — nothing sneaks into jsonb', () => {
  assert.equal(designSpecSchema.safeParse({ ...DEFAULT_SPEC, extra: 1 }).success, false);
  const nested = structuredClone(DEFAULT_SPEC) as unknown as Record<string, unknown>;
  (nested.transform as Record<string, unknown>).__proto__polluted = true;
  assert.equal(designSpecSchema.safeParse(nested).success, false);
});

check('rejects missing sections and fields', () => {
  const { filters: _dropped, ...noFilters } = DEFAULT_SPEC;
  assert.equal(designSpecSchema.safeParse(noFilters).success, false);
  const partialTransform = structuredClone(DEFAULT_SPEC) as unknown as Record<string, unknown>;
  delete (partialTransform.transform as Record<string, unknown>).rotation;
  assert.equal(designSpecSchema.safeParse(partialTransform).success, false);
});

check('rejects a future version — v2 needs a migration, not a silent pass', () => {
  assert.equal(designSpecSchema.safeParse({ ...structuredClone(DEFAULT_SPEC), version: 2 }).success, false);
});

check('rejects null where JSON serialisation turned NaN into null', () => {
  const viaJson = JSON.parse(
    JSON.stringify(DEFAULT_SPEC).replace('"scale":1', '"scale":null'),
  );
  assert.equal(designSpecSchema.safeParse(viaJson).success, false);
});

check('rejects string numbers — "1" is not 1', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_SPEC).replace('"scale":1', '"scale":"1"'));
  assert.equal(designSpecSchema.safeParse(bad).success, false);
});

check('parseDesignSpec names the offending field for the 400 response', () => {
  const bad = structuredClone(DEFAULT_SPEC) as { transform: { scale: number } };
  bad.transform.scale = 99;
  const result = parseDesignSpec(bad);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /transform\.scale/);
});

check('a legacy spec WITHOUT the cutout field parses, defaulting to false', () => {
  const legacy = JSON.parse(JSON.stringify(DEFAULT_SPEC)) as Record<string, unknown>;
  delete legacy.cutout;
  const parsed = designSpecSchema.parse(legacy);
  assert.equal(parsed.cutout, false, 'absence must mean false, not rejection');
});

check('cutout accepts booleans and rejects everything else', () => {
  assert.equal(designSpecSchema.parse({ ...structuredClone(DEFAULT_SPEC), cutout: true }).cutout, true);
  assert.equal(designSpecSchema.safeParse({ ...structuredClone(DEFAULT_SPEC), cutout: 'yes' }).success, false);
  assert.equal(designSpecSchema.safeParse({ ...structuredClone(DEFAULT_SPEC), cutout: 1 }).success, false);
});

check('parseDesignSpec returns the typed spec on success', () => {
  const result = parseDesignSpec(structuredClone(DEFAULT_SPEC));
  assert.equal(result.ok, true);
  assert.deepEqual((result as { spec: DesignSpec }).spec, DEFAULT_SPEC);
});

console.log(`\n${count} assertions passed.`);
