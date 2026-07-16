// Undo/redo and drag semantics — the data-loss cases. When undo is wrong the
// user loses work they cannot get back, so every test here asserts on exact
// spec values, not just stack depths.
import assert from 'node:assert/strict';
import { createEditorStore } from '../src/stores/editor';
import { DEFAULT_SPEC } from '../src/lib/mockup/types';

let count = 0;
function check(label: string, fn: () => void): void {
  fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

check('apply creates one undo step; undo restores the previous spec exactly', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.3 } });
  assert.equal(store.getState().spec.transform.x, 0.3);
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
});

check('two applies undo in reverse order', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.1 } });
  store.getState().apply({ transform: { rotation: 90 } });
  store.getState().undo();
  assert.equal(store.getState().spec.transform.rotation, 0);
  assert.equal(store.getState().spec.transform.x, 0.1);
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
});

check('redo restores the undone state', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { scale: 2 } });
  store.getState().undo();
  assert.equal(store.getState().spec.transform.scale, 1);
  store.getState().redo();
  assert.equal(store.getState().spec.transform.scale, 2);
});

check('a new apply invalidates the redo branch', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.1 } });
  store.getState().undo();
  store.getState().apply({ transform: { x: 0.5 } });
  assert.equal(store.getState().canRedo(), false);
  store.getState().redo(); // must be a no-op, not a resurrection of x=0.1
  assert.equal(store.getState().spec.transform.x, 0.5);
});

check('undo on empty history is a safe no-op', () => {
  const store = createEditorStore();
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
  assert.equal(store.getState().canUndo(), false);
});

check('redo on empty future is a safe no-op', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.2 } });
  store.getState().redo();
  assert.equal(store.getState().spec.transform.x, 0.2);
});

check('a 200-frame drag is ONE undo step, and undo restores the PRE-drag spec', () => {
  // The documented bug: commit() once pushed the current spec — but by then
  // preview() had overwritten it 200 times, so undo restored the end of the
  // drag (did nothing) and the pre-drag value was gone for good.
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.25 } }); // pre-drag state to protect
  for (let frame = 1; frame <= 200; frame++) {
    store.getState().preview({ transform: { x: 0.25 + (frame / 200) * 0.5 } });
  }
  store.getState().commit();
  assert.equal(store.getState().spec.transform.x, 0.75);

  store.getState().undo();
  assert.equal(store.getState().spec.transform.x, 0.25, 'undo must restore the pre-drag value');
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
});

check('preview frames alone create no history', () => {
  const store = createEditorStore();
  store.getState().preview({ transform: { y: 0.4 } });
  assert.equal(store.getState().history.length, 0);
  assert.equal(store.getState().spec.transform.y, 0.4);
});

check('commit without a drag in flight records nothing', () => {
  const store = createEditorStore();
  store.getState().commit();
  store.getState().commit();
  assert.equal(store.getState().history.length, 0);
  assert.equal(store.getState().canUndo(), false);
});

check('cancelDrag restores the pre-drag spec with no history entry', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.2 } });
  store.getState().preview({ transform: { x: 0.9 } });
  store.getState().cancelDrag();
  assert.equal(store.getState().spec.transform.x, 0.2);
  assert.equal(store.getState().history.length, 1, 'only the apply is in history');
});

check('two separate drags are two undo steps', () => {
  const store = createEditorStore();
  store.getState().preview({ transform: { x: 0.3 } });
  store.getState().commit();
  store.getState().preview({ transform: { y: 0.3 } });
  store.getState().commit();
  store.getState().undo();
  assert.equal(store.getState().spec.transform.y, 0);
  assert.equal(store.getState().spec.transform.x, 0.3);
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
});

check('undo during a drag commits it first — the drag comes off, nothing else', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { rotation: 45 } });
  store.getState().preview({ transform: { rotation: 120 } });
  store.getState().undo(); // no commit() call — user hits Ctrl+Z mid-drag
  assert.equal(store.getState().spec.transform.rotation, 45, 'the drag is undone');
  assert.equal(store.getState().dragBase, null);
});

check('apply during a drag closes the drag as its own undo step', () => {
  const store = createEditorStore();
  store.getState().preview({ transform: { x: 0.4 } });
  store.getState().apply({ filters: { contrast: 1.5 } }); // e.g. a button clicked mid-drag
  assert.equal(store.getState().spec.transform.x, 0.4);
  assert.equal(store.getState().spec.filters.contrast, 1.5);
  store.getState().undo();
  assert.equal(store.getState().spec.filters.contrast, 1, 'apply undone');
  assert.equal(store.getState().spec.transform.x, 0.4, 'drag survives');
  store.getState().undo();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
});

check('history entries are deep copies: mutating a stale reference cannot corrupt undo', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.3 } });
  const stale = store.getState().spec; // caller keeps a reference…
  store.getState().apply({ transform: { x: 0.6 } });
  // …and (wrongly) mutates it after the fact.
  (stale.transform as { x: number }).x = 999;
  store.getState().undo();
  assert.equal(store.getState().spec.transform.x, 0.3, 'history must hold its own copy');
});

check('redo branch: undo after redo still walks the same line', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.1 } });
  store.getState().apply({ transform: { x: 0.2 } });
  store.getState().undo();
  store.getState().redo();
  assert.equal(store.getState().spec.transform.x, 0.2);
  store.getState().undo();
  assert.equal(store.getState().spec.transform.x, 0.1);
});

check('history is capped: a marathon session cannot grow memory without bound', () => {
  const store = createEditorStore();
  for (let i = 0; i < 150; i++) {
    store.getState().apply({ transform: { rotation: i % 90 } });
  }
  assert.ok(store.getState().history.length <= 100, `history at ${store.getState().history.length}`);
});

check('reset clears spec, history, future and any drag', () => {
  const store = createEditorStore();
  store.getState().apply({ transform: { x: 0.5 } });
  store.getState().preview({ transform: { y: 0.5 } });
  store.getState().reset();
  assert.deepEqual(store.getState().spec, DEFAULT_SPEC);
  assert.equal(store.getState().canUndo(), false);
  assert.equal(store.getState().canRedo(), false);
  assert.equal(store.getState().dragBase, null);
});

console.log(`\n${count} assertions passed.`);
