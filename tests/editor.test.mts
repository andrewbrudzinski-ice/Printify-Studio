// applyPatch: merging, clamps, purity, and the values that must never reach a
// spec. The spec is what gets printed — a bad value here surfaces after
// payment, which is the most expensive place to find it.
import assert from 'node:assert/strict';
import { applyPatch } from '../src/stores/editor';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';
import type { DesignSpec } from '../src/lib/mockup/types';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

function spec(): DesignSpec {
  return structuredClone(DEFAULT_SPEC);
}

check('a transform patch merges; untouched fields survive', () => {
  const out = applyPatch(spec(), { transform: { x: 0.2, rotation: 45 } });
  assert.equal(out.transform.x, 0.2);
  assert.equal(out.transform.rotation, 45);
  assert.equal(out.transform.y, 0);
  assert.equal(out.transform.scale, 1);
  assert.deepEqual(out.filters, DEFAULT_SPEC.filters);
});

check('a filters patch merges without touching the transform', () => {
  const out = applyPatch(spec(), { filters: { saturation: 1.4 } });
  assert.equal(out.filters.saturation, 1.4);
  assert.equal(out.filters.brightness, 1);
  assert.deepEqual(out.transform, DEFAULT_SPEC.transform);
});

check('an empty patch is an identity', () => {
  const out = applyPatch(spec(), {});
  assert.deepEqual(out, DEFAULT_SPEC);
});

check('patch purity: the input spec is not mutated and the output is a new object', () => {
  const input = spec();
  const out = applyPatch(input, { transform: { x: 0.5, scale: 3 } });
  assert.deepEqual(input, DEFAULT_SPEC, 'input mutated');
  assert.notEqual(out, input);
  assert.notEqual(out.transform, input.transform, 'nested transform aliased');
  assert.notEqual(out.filters, input.filters, 'nested filters aliased');
});

check('zoom below 1 clamps to 1 — below cover-fit prints blank edges', () => {
  const out = applyPatch(spec(), { transform: { scale: 0.4 } });
  assert.equal(out.transform.scale, 1);
});

check('zoom above the ceiling clamps to it', () => {
  const out = applyPatch(spec(), { transform: { scale: 50 } });
  assert.equal(out.transform.scale, 8);
});

check('pan clamps to its bounds', () => {
  const out = applyPatch(spec(), { transform: { x: 9, y: -9 } });
  assert.equal(out.transform.x, 1);
  assert.equal(out.transform.y, -1);
});

check('filters clamp to their ranges', () => {
  const out = applyPatch(spec(), {
    filters: { brightness: 100, contrast: 0, saturation: -3 },
  });
  assert.equal(out.filters.brightness, 2);
  assert.equal(out.filters.contrast, 0.2);
  assert.equal(out.filters.saturation, 0, 'saturation 0 (greyscale) is legal');
});

check('rotation normalises into [-180, 180)', () => {
  assert.equal(applyPatch(spec(), { transform: { rotation: 450 } }).transform.rotation, 90);
  assert.equal(applyPatch(spec(), { transform: { rotation: -270 } }).transform.rotation, 90);
  assert.equal(applyPatch(spec(), { transform: { rotation: 180 } }).transform.rotation, -180);
  assert.equal(applyPatch(spec(), { transform: { rotation: 0 } }).transform.rotation, 0);
});

check('non-finite values are ignored, not stored', () => {
  const out = applyPatch(spec(), {
    transform: { scale: NaN, x: Infinity },
    filters: { brightness: -Infinity },
  });
  assert.equal(out.transform.scale, 1);
  assert.equal(out.transform.x, 0);
  assert.equal(out.filters.brightness, 1);
});

check('patched specs survive a JSON round-trip intact', () => {
  // The spec is stored in a jsonb column at checkout; anything JSON loses
  // (undefined, NaN, Infinity) must never be present.
  const out = applyPatch(spec(), { transform: { x: 0.31, rotation: -12 }, filters: { contrast: 1.2 } });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

check('version is always 1 on output', () => {
  const out = applyPatch(spec(), { transform: { x: 0.1 } });
  assert.equal(out.version, 1);
});

console.log(`\n${count} assertions passed.`);
