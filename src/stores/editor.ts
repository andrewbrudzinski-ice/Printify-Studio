// Editor state: the DesignSpec plus undo/redo. Framework-free (zustand
// vanilla) so the whole thing is testable without a browser; React components
// bind with useStore(editorStore) later.
//
// The DesignSpec is the ONLY source of truth. There is no separate canvas
// state and no "apply" button — every control writes the spec, the preview
// re-renders from it with the same renderer that produces the print file.
//
// History is an array of whole specs, not a patch log. A spec is a few
// hundred bytes; snapshot undo can't develop the subtle inverse-patch bugs
// that lose data. When undo is wrong the user loses work they cannot get
// back — boring and correct wins.

import { createStore } from 'zustand/vanilla';
import { DEFAULT_SPEC, type DesignSpec } from '../lib/mockup/types';
// Editor policy bounds live with the checkout spec schema — one definition,
// so a value the editor can produce is always a value checkout accepts.
// scale's lower bound is the one that matters: below cover-fit (1) the
// artwork stops covering the print area and the PHYSICAL product prints
// blank edges. The schema still re-validates — clamps are UX, not security.
import { SPEC_LIMITS as LIMITS } from '../lib/mockup/spec';

export interface SpecPatch {
  transform?: Partial<DesignSpec['transform']>;
  filters?: Partial<DesignSpec['filters']>;
  cutout?: boolean;
}

function clamp(v: number, [lo, hi]: readonly [number, number]): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Normalise to [-180, 180) so a spec never accumulates unbounded turns.
function normaliseRotation(deg: number): number {
  return ((deg % 360) + 540) % 360 - 180;
}

// Take a candidate value only if it's a real number. A NaN that slips into
// the spec survives JSON round-trips as null and detonates in the print
// pipeline — after payment. Ignoring the field keeps the previous value.
function finiteOr(candidate: number | undefined, previous: number): number {
  return candidate !== undefined && Number.isFinite(candidate) ? candidate : previous;
}

// Pure: never mutates its inputs, always returns a fresh spec. Everything the
// store does relies on this — snapshots would silently alias otherwise.
export function applyPatch(spec: DesignSpec, patch: SpecPatch): DesignSpec {
  const t = patch.transform ?? {};
  const f = patch.filters ?? {};
  return {
    version: 1,
    transform: {
      x: clamp(finiteOr(t.x, spec.transform.x), LIMITS.pan),
      y: clamp(finiteOr(t.y, spec.transform.y), LIMITS.pan),
      scale: clamp(finiteOr(t.scale, spec.transform.scale), LIMITS.scale),
      rotation: normaliseRotation(finiteOr(t.rotation, spec.transform.rotation)),
    },
    filters: {
      brightness: clamp(finiteOr(f.brightness, spec.filters.brightness), LIMITS.brightness),
      contrast: clamp(finiteOr(f.contrast, spec.filters.contrast), LIMITS.contrast),
      saturation: clamp(finiteOr(f.saturation, spec.filters.saturation), LIMITS.saturation),
    },
    cutout: typeof patch.cutout === 'boolean' ? patch.cutout : spec.cutout,
  };
}

export interface EditorStore {
  spec: DesignSpec;
  // Past snapshots, oldest first. Entries are deep copies: nothing outside
  // the store can reach into history and corrupt it.
  history: DesignSpec[];
  future: DesignSpec[];
  // The spec as it was when the current drag started — captured on the FIRST
  // preview frame. commit() pushes THIS, not the current spec: by commit
  // time, preview() has overwritten the spec a couple hundred times, and
  // pushing the current spec would make undo restore the end of the drag,
  // i.e. do nothing, with the pre-drag value gone for good.
  dragBase: DesignSpec | null;

  // One discrete edit = one undo step (a slider release, a button).
  apply(patch: SpecPatch): void;
  // A drag frame: updates the spec, records nothing. Call commit() on release.
  preview(patch: SpecPatch): void;
  // End the drag as a single undo step. No-op if no drag is in flight.
  commit(): void;
  // Abandon the drag (Escape): restore the pre-drag spec, no history entry.
  cancelDrag(): void;
  undo(): void;
  redo(): void;
  reset(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

// Snapshots are a few hundred bytes; 100 of them is nothing, and a bound
// means a marathon session can't grow memory without limit.
const HISTORY_LIMIT = 100;

function pushCapped(stack: DesignSpec[], entry: DesignSpec): DesignSpec[] {
  const out = [...stack, entry];
  return out.length > HISTORY_LIMIT ? out.slice(out.length - HISTORY_LIMIT) : out;
}

export function createEditorStore(initial: DesignSpec = DEFAULT_SPEC) {
  return createStore<EditorStore>()((set, get) => ({
    spec: structuredClone(initial),
    history: [],
    future: [],
    dragBase: null,

    apply(patch) {
      // An apply landing mid-drag first closes the drag as its own undo step,
      // so neither edit can swallow the other.
      get().commit();
      const s = get();
      set({
        spec: applyPatch(s.spec, patch),
        history: pushCapped(s.history, structuredClone(s.spec)),
        future: [],
      });
    },

    preview(patch) {
      const s = get();
      set({
        dragBase: s.dragBase ?? structuredClone(s.spec),
        spec: applyPatch(s.spec, patch),
      });
    },

    commit() {
      const s = get();
      if (!s.dragBase) return;
      set({
        history: pushCapped(s.history, s.dragBase),
        dragBase: null,
        future: [],
      });
    },

    cancelDrag() {
      const s = get();
      if (!s.dragBase) return;
      set({ spec: s.dragBase, dragBase: null });
    },

    undo() {
      // Undo during a drag first commits it, then steps back over it — the
      // user sees the drag come off, not the edit before it vanish.
      get().commit();
      const s = get();
      const prev = s.history[s.history.length - 1];
      if (!prev) return;
      set({
        spec: prev,
        history: s.history.slice(0, -1),
        future: [...s.future, structuredClone(s.spec)],
      });
    },

    redo() {
      get().commit(); // commit() clears future, making redo mid-drag a no-op
      const s = get();
      const next = s.future[s.future.length - 1];
      if (!next) return;
      set({
        spec: next,
        future: s.future.slice(0, -1),
        history: [...s.history, structuredClone(s.spec)],
      });
    },

    reset() {
      set({
        spec: structuredClone(initial),
        history: [],
        future: [],
        dragBase: null,
      });
    },

    canUndo() {
      const s = get();
      return s.history.length > 0 || s.dragBase !== null;
    },

    canRedo() {
      return get().future.length > 0;
    },
  }));
}

// The app-wide store. Tests create their own with createEditorStore().
export const editorStore = createEditorStore();
