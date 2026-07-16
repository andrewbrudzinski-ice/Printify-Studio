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

  setPhoto(input: { file: File; width: number; height: number; objectUrl: string }): void;
  setUpload(patch: Partial<ArtworkStore['upload']>): void;
  reset(): void;
}

const EMPTY_UPLOAD = { status: 'idle' as UploadStatus, imageId: null, path: null, error: null };

export const artworkStore = createStore<ArtworkStore>()((set, get) => ({
  file: null,
  width: 0,
  height: 0,
  objectUrl: null,
  upload: { ...EMPTY_UPLOAD },

  setPhoto({ file, width, height, objectUrl }) {
    const previous = get().objectUrl;
    if (previous) URL.revokeObjectURL(previous);
    set({ file, width, height, objectUrl, upload: { ...EMPTY_UPLOAD } });
  },

  setUpload(patch) {
    set({ upload: { ...get().upload, ...patch } });
  },

  reset() {
    const previous = get().objectUrl;
    if (previous) URL.revokeObjectURL(previous);
    set({ file: null, width: 0, height: 0, objectUrl: null, upload: { ...EMPTY_UPLOAD } });
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
