// The identity seam: two cart items may share (templateSlug, variantSku) and
// quantity — the same mug with two different photos — and must NEVER collapse
// into one design. This suite pins both the fix (position is identity) and
// the wrongness of the old value-lookup logic, so the reasoning survives.
import assert from 'node:assert/strict';
import { zipByPosition } from '../src/lib/checkout/mapping';
import { createCartStore } from '../src/stores/cart';
import { applyPatch } from '../src/stores/editor';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

// Two mugs, same SKU, same quantity — different photos.
const DUPLICATE_ITEMS = [
  { variantSku: 'MUG-11-WHT', quantity: 1, designId: 'design-dog' },
  { variantSku: 'MUG-11-WHT', quantity: 1, designId: 'design-cat' },
];
// Priced lines are built by .map over the same items, so they align by index.
const PRICED_LINES = [
  { variantSku: 'MUG-11-WHT', quantity: 1, unitPrice: 1499 },
  { variantSku: 'MUG-11-WHT', quantity: 1, unitPrice: 1499 },
];

// --- The mapping seam ---------------------------------------------------------

check('duplicate (sku, quantity) items keep their own designs — never collapsed', () => {
  const rows = zipByPosition(DUPLICATE_ITEMS, PRICED_LINES, (item, line) => ({
    design_id: item.designId,
    unit_price: line.unitPrice,
  }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.design_id, 'design-dog');
  assert.equal(rows[1]!.design_id, 'design-cat');
});

check('the old value-lookup logic was provably wrong — pinned so the reasoning survives', () => {
  // This is the shipped bug, verbatim in spirit: match each item to a line by
  // (sku, quantity). Both items match the FIRST line; if designs had been
  // attached to lines, both rows would get the same design.
  const linesWithDesigns = DUPLICATE_ITEMS.map((i, idx) => ({
    variantSku: i.variantSku,
    quantity: i.quantity,
    designId: DUPLICATE_ITEMS[idx]!.designId,
  }));
  const oldLogic = DUPLICATE_ITEMS.map(
    (i) =>
      linesWithDesigns.find(
        (x) => x.variantSku === i.variantSku && x.quantity === i.quantity,
      )!.designId,
  );
  assert.deepEqual(oldLogic, ['design-dog', 'design-dog'], 'the customer receives the same photo twice');
  assert.notEqual(oldLogic[1], DUPLICATE_ITEMS[1]!.designId, 'the second design is silently lost');
});

check('order is preserved item-by-item across a mixed cart', () => {
  const items = [
    { sku: 'TEE-BLK-M', designId: 'd1' },
    { sku: 'MUG-11-WHT', designId: 'd2' },
    { sku: 'TEE-BLK-M', designId: 'd3' },
    { sku: 'KEY-ACR', designId: 'd4' },
    { sku: 'MUG-11-WHT', designId: 'd5' },
  ];
  const lines = items.map((i, idx) => ({ sku: i.sku, price: 1000 + idx }));
  const rows = zipByPosition(items, lines, (item, line, idx) => ({
    design: item.designId,
    price: line.price,
    idx,
  }));
  for (let i = 0; i < items.length; i++) {
    assert.equal(rows[i]!.design, items[i]!.designId);
    assert.equal(rows[i]!.price, 1000 + i);
    assert.equal(rows[i]!.idx, i);
  }
});

check('a length mismatch throws instead of mispairing customers and designs', () => {
  assert.throws(
    () => zipByPosition(DUPLICATE_ITEMS, PRICED_LINES.slice(0, 1), (a) => a),
    /Positional identity broken: 2 items but 1 lines/,
  );
});

// --- The cart store -------------------------------------------------------------

check('adding the same SKU twice with different specs yields two distinct lines', () => {
  const cart = createCartStore();
  const dogSpec = applyPatch(DEFAULT_SPEC, { transform: { x: 0.2 } });
  const catSpec = applyPatch(DEFAULT_SPEC, { transform: { x: -0.2 } });
  const a = cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: dogSpec, imageRef: 'u/dog.jpg' });
  const b = cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: catSpec, imageRef: 'u/cat.jpg' });
  assert.notEqual(a, b, 'line ids must differ');
  assert.equal(cart.getState().items.length, 2);
  assert.equal(cart.getState().items[0]!.spec.transform.x, 0.2);
  assert.equal(cart.getState().items[1]!.spec.transform.x, -0.2);
});

check('removeItem removes exactly its line; the same-SKU sibling survives', () => {
  const cart = createCartStore();
  const a = cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/dog.jpg' });
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/cat.jpg' });
  cart.getState().removeItem(a);
  assert.equal(cart.getState().items.length, 1);
  assert.equal(cart.getState().items[0]!.imageRef, 'u/cat.jpg');
});

check('setQuantity clamps to [1, 99] and floors fractions', () => {
  const cart = createCartStore();
  const id = cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/a.jpg' });
  cart.getState().setQuantity(id, 0);
  assert.equal(cart.getState().items[0]!.quantity, 1);
  cart.getState().setQuantity(id, 2.9);
  assert.equal(cart.getState().items[0]!.quantity, 2);
  cart.getState().setQuantity(id, 500);
  assert.equal(cart.getState().items[0]!.quantity, 99);
  cart.getState().setQuantity(id, NaN);
  assert.equal(cart.getState().items[0]!.quantity, 1);
});

check('setSpec touches only its own line', () => {
  const cart = createCartStore();
  const a = cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/a.jpg' });
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/b.jpg' });
  cart.getState().setSpec(a, applyPatch(DEFAULT_SPEC, { transform: { rotation: 45 } }));
  assert.equal(cart.getState().items[0]!.spec.transform.rotation, 45);
  assert.equal(cart.getState().items[1]!.spec.transform.rotation, 0);
});

check('the cart deep-copies specs — the editor mutating afterwards cannot reach in', () => {
  // The shipped bug in reverse: checkout once sent DEFAULT_SPEC instead of
  // the edited spec. Equally bad is a live reference that keeps changing
  // after the customer approved what they saw.
  const cart = createCartStore();
  const editorSpec = structuredClone(DEFAULT_SPEC);
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: editorSpec, imageRef: 'u/a.jpg' });
  (editorSpec.transform as { x: number }).x = 0.9; // editor keeps editing
  assert.equal(cart.getState().items[0]!.spec.transform.x, 0, 'cart must own its copy');
});

check('toCheckoutPayload preserves insertion order, carries specs, omits prices', () => {
  const cart = createCartStore();
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: applyPatch(DEFAULT_SPEC, { transform: { x: 0.1 } }), imageRef: 'u/1.jpg' });
  cart.getState().addItem({ templateSlug: 'tshirt', variantSku: 'TEE-BLK-M', spec: DEFAULT_SPEC, imageRef: 'u/2.jpg', quantity: 3 });
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: applyPatch(DEFAULT_SPEC, { transform: { x: -0.1 } }), imageRef: 'u/3.jpg' });

  const payload = cart.getState().toCheckoutPayload();
  assert.equal(payload.items.length, 3);
  assert.deepEqual(
    payload.items.map((i) => i.variantSku),
    ['MUG-11-WHT', 'TEE-BLK-M', 'MUG-11-WHT'],
  );
  assert.equal(payload.items[0]!.spec.transform.x, 0.1);
  assert.equal(payload.items[2]!.spec.transform.x, -0.1);
  assert.equal(payload.items[1]!.quantity, 3);
  for (const item of payload.items) {
    assert.ok(!('price' in item) && !('unitPrice' in item), 'no client-side prices, ever');
  }
});

check('clear empties the cart; count sums quantities', () => {
  const cart = createCartStore();
  cart.getState().addItem({ templateSlug: 'mug', variantSku: 'MUG-11-WHT', spec: DEFAULT_SPEC, imageRef: 'u/1.jpg', quantity: 2 });
  cart.getState().addItem({ templateSlug: 'keychain', variantSku: 'KEY-ACR', spec: DEFAULT_SPEC, imageRef: 'u/2.jpg' });
  assert.equal(cart.getState().count(), 3);
  cart.getState().clear();
  assert.equal(cart.getState().items.length, 0);
  assert.equal(cart.getState().count(), 0);
});

console.log(`\n${count} assertions passed.`);
