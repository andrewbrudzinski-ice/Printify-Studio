// The customer's photo, client-side. The grid renders from the LOCAL bitmap
// the moment the photo decodes; the upload runs in parallel and the network
// is never in the critical path of the moment that sells the product. Only
// checkout genuinely needs the bytes to have arrived.

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

export interface ArtworkStore {
  // Decoded photo — client-only, deliberately not serialisable.
  file: File | null;
  width: number;
  height: number;
  objectUrl: string | null;

  upload: {
    status: UploadStatus;
    // Set once the row exists server-side; checkout needs this.
    imageId: string | null;
    path: string | null;
    error: string | null;
  };

  // The background-removed variant of the photo, once computed. The cut PNG
  // is uploaded as its OWN image row (same flow as the original), so designs
  // that use it just point at a different image_id — the print path never
  // special-cases cutouts.
  cutout: {
    status: 'none' | 'running' | 'done' | 'error';
    // Local preview source for the cut image.
    file: File | null;
    objectUrl: string | null;
    imageId: string | null;
    error: string | null;
  };

  setPhoto(input: { file: File; width: number; height: number; objectUrl: string }): void;
  setUpload(patch: Partial<ArtworkStore['upload']>): void;
  setCutout(patch: Partial<ArtworkStore['cutout']>): void;
  reset(): void;
}

const EMPTY_UPLOAD = { status: 'idle' as UploadStatus, imageId: null, path: null, error: null };
const EMPTY_CUTOUT = {
  status: 'none' as const,
  file: null,
  objectUrl: null,
  imageId: null,
  error: null,
};

export const artworkStore = createStore<ArtworkStore>()((set, get) => ({
  file: null,
  width: 0,
  height: 0,
  objectUrl: null,
  upload: { ...EMPTY_UPLOAD },
  cutout: { ...EMPTY_CUTOUT },

  setPhoto({ file, width, height, objectUrl }) {
    const previous = get().objectUrl;
    if (previous) URL.revokeObjectURL(previous);
    const previousCut = get().cutout.objectUrl;
    if (previousCut) URL.revokeObjectURL(previousCut);
    // A new photo invalidates any cutout of the old one.
    set({ file, width, height, objectUrl, upload: { ...EMPTY_UPLOAD }, cutout: { ...EMPTY_CUTOUT } });
  },

  setUpload(patch) {
    set({ upload: { ...get().upload, ...patch } });
  },

  setCutout(patch) {
    set({ cutout: { ...get().cutout, ...patch } });
  },

  reset() {
    const previous = get().objectUrl;
    if (previous) URL.revokeObjectURL(previous);
    const previousCut = get().cutout.objectUrl;
    if (previousCut) URL.revokeObjectURL(previousCut);
    set({
      file: null,
      width: 0,
      height: 0,
      objectUrl: null,
      upload: { ...EMPTY_UPLOAD },
      cutout: { ...EMPTY_CUTOUT },
    });
  },
}));

export function useArtwork<T>(selector: (s: ArtworkStore) => T): T {
  return useStore(artworkStore, selector);
}

// The anonymous session token: how an anonymous visitor proves ownership of
// their uploads (namespaced anon/<token>/) until claim_anon_projects() runs
// at signup. Stable across page loads via localStorage.
const ANON_TOKEN_KEY = 'ps-anon-token';

export function anonToken(): string {
  if (typeof window === 'undefined') return '';
  let token = window.localStorage.getItem(ANON_TOKEN_KEY);
  if (!token) {
    token = crypto.randomUUID();
    window.localStorage.setItem(ANON_TOKEN_KEY, token);
  }
  return token;
}
