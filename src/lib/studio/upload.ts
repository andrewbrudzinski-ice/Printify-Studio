// Background image upload, shared by the original photo (UploadClient) and
// the cut-out variant (the editor's cutout flow). One implementation so both
// kinds of image land through the same signed-URL path and become the same
// kind of project_images row — the print pipeline cannot tell them apart,
// which is the point.

import { anonToken } from '../../stores/artwork';
import { supabaseBrowser } from '../supabase/client';

export interface UploadedImage {
  imageId: string;
  path: string;
}

export async function uploadImage(
  file: Blob & { type: string },
  width: number,
  height: number,
): Promise<UploadedImage> {
  const res = await fetch('/api/upload/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      width,
      height,
      contentType: file.type || 'image/jpeg',
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

  const { error } = await supabaseBrowser().storage.from('uploads').uploadToSignedUrl(path, token, file);
  if (error) throw new Error(error.message);

  return { imageId, path };
}
