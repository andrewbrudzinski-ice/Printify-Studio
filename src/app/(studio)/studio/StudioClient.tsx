'use client';

// The mockup grid. Renders from the local bitmap the moment we land here —
// the photo was decoded on /upload, the upload is still running behind us,
// and the network is not in the critical path of this screen.
//
// Rendering happens in a Web Worker (the same renderMockup as print), one
// product per message, so tiles stream in as they finish.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useArtwork } from '@/stores/artwork';
import { templateAssetBaseUrl } from '@/lib/mockup/browserEnv';
import { qualityByTemplate, type CatalogueTemplateDto, type TemplateQuality } from '@/lib/studio/grid';
import { DEFAULT_SPEC } from '@/lib/mockup/types';
import type { TileError, TileResult, WorkerRequest } from '@/workers/mockup.worker';

const TILE_SIZE = 400;

interface TileState {
  bitmap: ImageBitmap | null;
  degraded: boolean;
  error: string | null;
}

export default function StudioClient() {
  const router = useRouter();
  const file = useArtwork((s) => s.file);
  const width = useArtwork((s) => s.width);
  const height = useArtwork((s) => s.height);
  const uploadStatus = useArtwork((s) => s.upload.status);

  const [templates, setTemplates] = useState<CatalogueTemplateDto[]>([]);
  const [quality, setQuality] = useState<Map<string, TemplateQuality>>(new Map());
  const [tiles, setTiles] = useState<Record<string, TileState>>({});
  const workerRef = useRef<Worker | null>(null);

  // No photo in memory (deep link, refresh) → back to the front door.
  useEffect(() => {
    if (!file) router.replace('/upload');
  }, [file, router]);

  // Catalogue: needed for layers and badges. On a zero-env deployment this
  // 503s; the grid then shows nothing but the page still explains itself.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/catalogue')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalogue unavailable'))))
      .then((body: { templates: CatalogueTemplateDto[] }) => {
        if (cancelled) return;
        setTemplates(body.templates);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (templates.length > 0 && width > 0) {
      setQuality(qualityByTemplate(width, height, templates));
    }
  }, [templates, width, height]);

  // One worker for the whole grid: init once with the photo, then stream a
  // render request per product.
  useEffect(() => {
    if (!file || templates.length === 0) return;

    const worker = new Worker(new URL('../../../workers/mockup.worker.ts', import.meta.url));
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<TileResult | TileError>) => {
      const msg = e.data;
      if (msg.type === 'error') {
        // Loud, not silent: a tile that can't render is a bug to see, and
        // the message is the only clue a bug report will carry.
        console.error(`mockup render failed for ${msg.slug}: ${msg.message}`);
      }
      setTiles((prev) => ({
        ...prev,
        [msg.slug]:
          msg.type === 'tile'
            ? { bitmap: msg.bitmap, degraded: msg.degraded, error: null }
            : { bitmap: null, degraded: false, error: msg.message },
      }));
    };

    void file.arrayBuffer().then((photo) => {
      const init: WorkerRequest = {
        type: 'init',
        photo,
        mime: file.type,
        assetBaseUrl: templateAssetBaseUrl(),
      };
      worker.postMessage(init, [photo]);
      for (const t of templates) {
        const render: WorkerRequest = {
          type: 'render',
          slug: t.slug,
          layers: t.mockupLayers,
          spec: DEFAULT_SPEC,
          size: TILE_SIZE,
        };
        worker.postMessage(render);
      }
    });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, [file, templates]);

  if (!file) return null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your photo, on everything</h1>
          <p className="mt-1 text-neutral-600">
            Tap a product to customise it.
            {uploadStatus === 'error' && (
              <span className="ml-2 text-amber-700">
                (Background upload failed — previews still work; we&apos;ll retry at checkout.)
              </span>
            )}
          </p>
        </div>
      </header>

      {templates.length === 0 ? (
        <p className="text-neutral-500">
          The catalogue isn&apos;t available. If this is a fresh deployment, connect Supabase and
          apply the seed migration.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
          {templates.map((t) => (
            <ProductTile
              key={t.slug}
              template={t}
              tile={tiles[t.slug]}
              quality={quality.get(t.slug)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function ProductTile({
  template,
  tile,
  quality,
}: {
  template: CatalogueTemplateDto;
  tile: TileState | undefined;
  quality: TemplateQuality | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tile?.bitmap) return;
    canvas.width = tile.bitmap.width;
    canvas.height = tile.bitmap.height;
    canvas.getContext('2d')?.drawImage(tile.bitmap, 0, 0);
  }, [tile]);

  const fromPrice = template.variants.length
    ? Math.min(...template.variants.map((v) => v.price))
    : null;

  return (
    <Link
      href={`/customize/${template.slug}`}
      className="group block overflow-hidden rounded-xl border border-neutral-200 transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-square bg-neutral-200">
        {tile?.bitmap ? (
          <canvas ref={canvasRef} className="h-full w-full" />
        ) : tile?.error ? (
          <div
            title={tile.error}
            className="flex h-full items-center justify-center p-4 text-center text-xs text-neutral-500"
          >
            Preview unavailable
          </div>
        ) : (
          <div className="h-full w-full animate-pulse bg-neutral-200" />
        )}
        {quality && quality.tier === 'low' && (
          <span className="absolute left-2 top-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            photo too small to print
          </span>
        )}
        {quality && quality.tier === 'great' && (
          <span className="absolute left-2 top-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
            crisp print
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between p-3">
        <span className="font-medium">{template.name}</span>
        {fromPrice !== null && (
          <span className="text-sm text-neutral-500">from ${(fromPrice / 100).toFixed(2)}</span>
        )}
      </div>
    </Link>
  );
}
