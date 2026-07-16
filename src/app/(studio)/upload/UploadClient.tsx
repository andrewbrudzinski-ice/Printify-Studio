'use client';

// The funnel's front door. The moment a photo decodes we navigate to the grid
// and render from the LOCAL bitmap; the upload runs behind in parallel. A
// slow or failed upload never blocks seeing mockups — only checkout needs the
// bytes to have landed, and it can retry there.

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { artworkStore, anonToken } from '@/stores/artwork';
import { supabaseBrowser } from '@/lib/supabase/client';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export default function UploadClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!file.type.startsWith('image/')) {
        setError('That file is not a photo. Use a JPEG, PNG or WebP.');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError('That photo is over 20MB. Export a smaller copy and try again.');
        return;
      }

      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        setError('That photo could not be read. Try a different file.');
        return;
      }

      // Capture before close(): a closed ImageBitmap reports 0x0.
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();

      artworkStore.getState().setPhoto({
        file,
        width,
        height,
        objectUrl: URL.createObjectURL(file),
      });

      // Fire-and-forget: the grid must not wait on the network.
      void uploadInBackground(file, width, height);

      router.push('/studio');
    },
    [router],
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 px-6">
      <h1 className="text-3xl font-bold tracking-tight">Drop in a photo</h1>
      <p className="text-center text-neutral-600">
        See it on eleven products in seconds. Nothing is uploaded until you say so —
        previews render right here on your device.
      </p>

      <button
        type="button"
        className={`flex h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed transition-colors ${
          dragOver ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-300'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void onFile(file);
        }}
      >
        <span className="text-lg font-medium">Drag a photo here</span>
        <span className="text-sm text-neutral-500">or tap to choose — the camera works too</span>
      </button>

      {/* capture-capable input: mobile browsers offer the camera directly */}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />

      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}

// Compress client-side (a 12MP phone photo is ~5MB; the print pipeline needs
// pixels, not the camera's original bytes), then upload via a signed URL.
// Every failure lands in the store as state, not a thrown error — the local
// preview flow is already gone ahead without us.
async function uploadInBackground(file: File, width: number, height: number): Promise<void> {
  const store = artworkStore.getState();
  store.setUpload({ status: 'uploading', error: null });
  try {
    const { default: compress } = await import('browser-image-compression');
    const compressed = await compress(file, {
      maxWidthOrHeight: 4096,
      maxSizeMB: 8,
      useWebWorker: true,
    });

    const res = await fetch('/api/upload/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width,
        height,
        contentType: compressed.type || file.type,
        anonToken: anonToken(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Upload signing failed (HTTP ${res.status}).`);
    }
    const { imageId, path, token } = (await res.json()) as {
      imageId: string;
      path: string;
      token: string;
    };

    const { error } = await supabaseBrowser()
      .storage.from('uploads')
      .uploadToSignedUrl(path, token, compressed);
    if (error) throw new Error(error.message);

    artworkStore.getState().setUpload({ status: 'done', imageId, path });
  } catch (e) {
    artworkStore.getState().setUpload({
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
