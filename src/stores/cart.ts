// Cart state. Framework-free (zustand vanilla), like the editor store.
//
// A line's identity is its lineId — generated here, unique per add. Two lines
// may be byte-identical in (templateSlug, variantSku, quantity): the same mug
// with two different photos. Nothing in this store (or anywhere downstream)
// may look a line up by its field values; see src/lib/checkout/mapping.ts for
// the bug that rule comes from.
//
// Prices are deliberately absent. The UI reads display prices from the
// catalogue API, and checkout recomputes everything server-side from the
// database — a price stored here could only ever be wrong or ignored.

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { DesignSpec } from '../lib/mockup/types';

export interface CartItem {
  lineId: string;
  templateSlug: string;
  variantSku: string;
  quantity: number;
  // The design as approved by the customer. Deep-copied on add: the editor
  // keeps mutating its own spec afterwards, and checkout once hardcoded
  // DEFAULT_SPEC — the customer cropped, saw the crop in the cart, and
  // received the uncropped original. The cart owns its copy.
  spec: DesignSpec;
  // Client-side reference to the photo (upload path); becomes a real design
  // row via /api/designs/persist at checkout.
  imageRef: string;
}

export interface CheckoutPayloadItem {
  templateSlug: string;
  variantSku: string;
  quantity: number;
  spec: DesignSpec;
  imageRef: string;
}

export interface CartStore {
  items: CartItem[];
  addItem(input: {
    templateSlug: string;
    variantSku: string;
    spec: DesignSpec;
    imageRef: string;
    quantity?: number;
  }): string;
  removeItem(lineId: string): void;
  setQuantity(lineId: string, quantity: number): void;
  setSpec(lineId: string, spec: DesignSpec): void;
  clear(): void;
  count(): number;
  // What POST /api/stripe/checkout receives: no prices, positional order
  // preserved — the server's derived arrays (priced lines, design ids) align
  // with these items BY INDEX.
  toCheckoutPayload(): { items: CheckoutPayloadItem[] };
}

const QUANTITY_LIMIT = 99;

function clampQuantity(q: number): number {
  if (!Number.isFinite(q)) return 1;
  return Math.min(QUANTITY_LIMIT, Math.max(1, Math.floor(q)));
}

function newLineId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return `line_${cryptoApi.randomUUID()}`;
  return `line_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createCartStore() {
  return createStore<CartStore>()((set, get) => ({
    items: [],

    addItem(input) {
      const lineId = newLineId();
      const item: CartItem = {
        lineId,
        templateSlug: input.templateSlug,
        variantSku: input.variantSku,
        quantity: clampQuantity(input.quantity ?? 1),
        spec: structuredClone(input.spec),
        imageRef: input.imageRef,
      };
      set({ items: [...get().items, item] });
      return lineId;
    },

    removeItem(lineId) {
      set({ items: get().items.filter((i) => i.lineId !== lineId) });
    },

    setQuantity(lineId, quantity) {
      set({
        items: get().items.map((i) =>
          i.lineId === lineId ? { ...i, quantity: clampQuantity(quantity) } : i,
        ),
      });
    },

    setSpec(lineId, spec) {
      set({
        items: get().items.map((i) =>
          i.lineId === lineId ? { ...i, spec: structuredClone(spec) } : i,
        ),
      });
    },

    clear() {
      set({ items: [] });
    },

    count() {
      return get().items.reduce((sum, i) => sum + i.quantity, 0);
    },

    toCheckoutPayload() {
      return {
        items: get().items.map((i) => ({
          templateSlug: i.templateSlug,
          variantSku: i.variantSku,
          quantity: i.quantity,
          spec: structuredClone(i.spec),
          imageRef: i.imageRef,
        })),
      };
    },
  }));
}

// The app-wide cart. Tests construct their own.
export const cartStore = createCartStore();

export function useCart<T>(selector: (s: CartStore) => T): T {
  return useStore(cartStore, selector);
}
