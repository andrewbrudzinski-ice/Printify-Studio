'use client';

// The editor. Every control writes the DesignSpec through the editor store
// (preview/commit for drags, apply for discrete edits) and the preview
// re-renders from the spec with the SAME renderMockup() that will produce
// the print file. There is no separate canvas state and no "apply" step.
//
// Drags render at half resolution — motion hides the softness; a stalled
// drag does not.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from 'zustand';
import { editorStore } from '@/stores/editor';
import { cartStore } from '@/stores/cart';
import { artworkStore, useArtwork } from '@/stores/artwork';
import { createBrowserEnv, templateAssetBaseUrl } from '@/lib/mockup/browserEnv';
import { renderMockup } from '@/lib/mockup/renderer';
import { fallbackLayers, type CatalogueTemplateDto } from '@/lib/studio/grid';
import { ormbgProvider } from '@/lib/cutout/ormbg';
import { runCutout } from '@/lib/cutout/run';
import { isCutoutQualityError } from '@/lib/cutout/types';
import { uploadImage } from '@/lib/studio/upload';
import type { RenderEnv, SourceImage } from '@/lib/mockup/types';

const PREVIEW_SIZE = 640;
const DRAG_SIZE = 320;

export default function CustomizeClient({ slug }: { slug: string }) {
  const router = useRouter();
  const file = useArtwork((s) => s.file);
  const spec = useStore(editorStore, (s) => s.spec);
  const canUndo = useStore(editorStore, (s) => s.history.length > 0 || s.dragBase !== null);
  const canRedo = useStore(editorStore, (s) => s.future.length > 0);

  const [template, setTemplate] = useState<CatalogueTemplateDto | null>(null);
  const [variantSku, setVariantSku] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // State, not just a ref: the render effect must RE-RUN when the photo
  // finishes decoding. Calling draw() from the decode callback captured a
  // stale closure (a draw created before the template loaded) and the
  // preview deadlocked unpainted — found on the first real browser run.
  const [artworkReady, setArtworkReady] = useState(false);
  // Cutout availability decides whether the button exists at all — an
  // optional dependency that isn't installed must leave no trace in the UI.
  const [cutoutAvailable, setCutoutAvailable] = useState(false);
  const cutout = useArtwork((s) => s.cutout);
  const useCut = useStore(editorStore, (s) => s.spec.cutout);
  const cutRef = useRef<SourceImage | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const envRef = useRef<RenderEnv | null>(null);
  const artRef = useRef<SourceImage | null>(null);
  const draggingRef = useRef(false);
  const renderSeq = useRef(0);
  const dragState = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  const wheelCommit = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!file) router.replace('/upload');
  }, [file, router]);

  // Show the cutout button only if the model package is actually loadable.
  useEffect(() => {
    let cancelled = false;
    void ormbgProvider.isAvailable().then((ok) => {
      if (!cancelled) setCutoutAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Decode the cut image for rendering whenever one exists.
  const [cutReady, setCutReady] = useState(false);
  useEffect(() => {
    if (!cutout.file) {
      cutRef.current = null;
      setCutReady(false);
      return;
    }
    let closed = false;
    void createImageBitmap(cutout.file).then((bmp) => {
      if (closed) {
        bmp.close();
        return;
      }
      cutRef.current = bmp as unknown as SourceImage;
      setCutReady(true);
    });
    return () => {
      closed = true;
      (cutRef.current as ImageBitmap | null)?.close?.();
      cutRef.current = null;
      setCutReady(false);
    };
  }, [cutout.file]);

  // Fresh spec per product visit — a mug's crop doesn't belong on a poster.
  useEffect(() => {
    editorStore.getState().reset();
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/catalogue')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalogue unavailable'))))
      .then((body: { templates: CatalogueTemplateDto[] }) => {
        if (cancelled) return;
        const t = body.templates.find((x) => x.slug === slug) ?? null;
        setTemplate(t);
        setVariantSku(t?.variants[0]?.sku ?? null);
        setNotFound(!t);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!file) return;
    envRef.current = createBrowserEnv(templateAssetBaseUrl());
    let closed = false;
    void createImageBitmap(file).then((bmp) => {
      if (closed) {
        bmp.close();
        return;
      }
      artRef.current = bmp as unknown as SourceImage;
      setArtworkReady(true);
    });
    return () => {
      closed = true;
      (artRef.current as ImageBitmap | null)?.close?.();
      artRef.current = null;
      setArtworkReady(false);
    };
  }, [file]);

  const draw = useCallback(async () => {
    const canvas = canvasRef.current;
    const env = envRef.current;
    const currentSpec = editorStore.getState().spec;
    // spec.cutout selects which bitmap renders; if the cut version isn't
    // decoded yet, fall back to the original rather than painting nothing.
    const artwork = (currentSpec.cutout && cutRef.current) || artRef.current;
    if (!canvas || !env || !artwork || !template) return;

    const seq = ++renderSeq.current;
    const size = draggingRef.current ? DRAG_SIZE : PREVIEW_SIZE;

    try {
      let result;
      try {
        result = await renderMockup({
          env,
          layers: template.mockupLayers,
          artwork,
          spec: currentSpec,
          width: size,
          height: size,
        });
      } catch {
        // Template art missing — same grey-base fallback as the grid.
        result = await renderMockup({
          env,
          layers: fallbackLayers(template.mockupLayers),
          artwork,
          spec: currentSpec,
          width: size,
          height: size,
        });
      }
      if (seq !== renderSeq.current) return; // a newer frame superseded this one

      canvas.width = size;
      canvas.height = size;
      canvas
        .getContext('2d')!
        .drawImage(result.canvas as unknown as OffscreenCanvas, 0, 0);
    } catch (err) {
      // A preview that silently fails to paint is the vanishing-stickers bug
      // in a new hat. Loud, with the message a bug report needs.
      console.error(`editor preview render failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [template]);

  // Re-render on every spec change (previews included), and again the moment
  // the template, the decoded photo, or the decoded cutout becomes available.
  useEffect(() => {
    const unsubscribe = editorStore.subscribe(() => void draw());
    void draw();
    return unsubscribe;
  }, [draw, artworkReady, cutReady]);

  async function cutOutSubject() {
    if (!file) return;
    const store = artworkStore.getState();
    store.setCutout({ status: 'running', error: null });
    try {
      const run = await runCutout(ormbgProvider, file);
      const cutFile = new File([run.blob], 'cutout.png', { type: 'image/png' });
      store.setCutout({
        status: 'done',
        file: cutFile,
        objectUrl: URL.createObjectURL(run.blob),
      });
      editorStore.getState().apply({ cutout: true });

      // Upload the cut image in the background, exactly like the original —
      // it becomes its own image row, and designs that use it just point at
      // a different image_id. Failure is state, not an exception; checkout
      // blocks with an actionable message if it never lands.
      void uploadImage(run.blob as File, run.width, run.height)
        .then(({ imageId }) => artworkStore.getState().setCutout({ imageId }))
        .catch(() => undefined);
    } catch (e) {
      // The quality gate's message tells the user what to do INSTEAD; any
      // other failure gets a generic retry line.
      store.setCutout({
        status: 'error',
        error: isCutoutQualityError(e)
          ? (e as Error).message
          : 'Background removal failed. Try again in a moment.',
      });
    }
  }

  if (!file) return null;
  if (notFound) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20 text-center">
        <p className="text-neutral-600">That product doesn&apos;t exist. Head back to your grid.</p>
      </main>
    );
  }
  if (!template) {
    return <main className="mx-auto max-w-xl px-6 py-20 text-center text-neutral-500">Loading…</main>;
  }

  const t = spec.transform;
  const f = spec.filters;

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-6 py-10 lg:grid-cols-[1fr_320px]">
      <div>
        <h1 className="mb-4 text-2xl font-bold tracking-tight">{template.name}</h1>
        <canvas
          ref={canvasRef}
          className="aspect-square w-full max-w-2xl cursor-grab touch-none rounded-xl bg-neutral-200 active:cursor-grabbing"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const s = editorStore.getState().spec;
            dragState.current = { sx: e.clientX, sy: e.clientY, bx: s.transform.x, by: s.transform.y };
            draggingRef.current = true;
          }}
          onPointerMove={(e) => {
            const d = dragState.current;
            if (!d) return;
            const rect = e.currentTarget.getBoundingClientRect();
            editorStore.getState().preview({
              transform: {
                x: d.bx + (e.clientX - d.sx) / rect.width,
                y: d.by + (e.clientY - d.sy) / rect.height,
              },
            });
          }}
          onPointerUp={() => {
            dragState.current = null;
            draggingRef.current = false;
            editorStore.getState().commit();
            void draw(); // full-resolution frame now the drag ended
          }}
          onWheel={(e) => {
            const s = editorStore.getState().spec;
            editorStore.getState().preview({
              transform: { scale: s.transform.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06) },
            });
            if (wheelCommit.current) clearTimeout(wheelCommit.current);
            wheelCommit.current = setTimeout(() => editorStore.getState().commit(), 250);
          }}
        />
        <p className="mt-2 text-sm text-neutral-500">
          Drag to position - scroll to zoom - what you see is exactly what prints.
        </p>
      </div>

      <aside className="flex flex-col gap-6">
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Variant</h2>
          <select
            className="w-full rounded-lg border border-neutral-300 p-2"
            value={variantSku ?? ''}
            onChange={(e) => setVariantSku(e.target.value)}
          >
            {template.variants.map((v) => (
              <option key={v.sku} value={v.sku}>
                {v.name} — ${(v.price / 100).toFixed(2)}
              </option>
            ))}
          </select>
        </section>

        <section className="flex gap-2">
          <ToolButton
            label="Rotate"
            onClick={() => editorStore.getState().apply({ transform: { rotation: t.rotation + 90 } })}
          />
          <ToolButton label="Undo" disabled={!canUndo} onClick={() => editorStore.getState().undo()} />
          <ToolButton label="Redo" disabled={!canRedo} onClick={() => editorStore.getState().redo()} />
          <ToolButton label="Reset" onClick={() => editorStore.getState().reset()} />
        </section>

        {cutoutAvailable && (
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Subject
            </h2>
            {cutout.status === 'done' ? (
              <ToolButton
                label={useCut ? 'Show original photo' : 'Use the cut-out subject'}
                onClick={() => editorStore.getState().apply({ cutout: !useCut })}
              />
            ) : (
              <ToolButton
                label={cutout.status === 'running' ? 'Cutting…' : 'Cut out the subject'}
                disabled={cutout.status === 'running'}
                onClick={() => void cutOutSubject()}
              />
            )}
            {cutout.error && <p className="text-sm text-amber-700">{cutout.error}</p>}
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Adjust</h2>
          <Slider
            label="Zoom"
            min={1}
            max={4}
            step={0.01}
            value={t.scale}
            onPreview={(v) => editorStore.getState().preview({ transform: { scale: v } })}
            onCommit={() => editorStore.getState().commit()}
          />
          <Slider
            label="Brightness"
            min={0.5}
            max={1.5}
            step={0.01}
            value={f.brightness}
            onPreview={(v) => editorStore.getState().preview({ filters: { brightness: v } })}
            onCommit={() => editorStore.getState().commit()}
          />
          <Slider
            label="Contrast"
            min={0.5}
            max={1.5}
            step={0.01}
            value={f.contrast}
            onPreview={(v) => editorStore.getState().preview({ filters: { contrast: v } })}
            onCommit={() => editorStore.getState().commit()}
          />
          <Slider
            label="Saturation"
            min={0}
            max={2}
            step={0.01}
            value={f.saturation}
            onPreview={(v) => editorStore.getState().preview({ filters: { saturation: v } })}
            onCommit={() => editorStore.getState().commit()}
          />
        </section>

        <button
          type="button"
          className="rounded-xl bg-neutral-900 px-6 py-3 font-medium text-white transition-opacity disabled:opacity-40"
          disabled={!variantSku}
          onClick={() => {
            if (!variantSku) return;
            // The cart deep-copies the spec: edits after this click cannot
            // change what the customer just approved.
            cartStore.getState().addItem({
              templateSlug: template.slug,
              variantSku,
              spec: editorStore.getState().spec,
              imageRef: artworkStore.getState().upload.imageId ?? 'pending-upload',
            });
            router.push('/cart');
          }}
        >
          Add to cart
        </button>
      </aside>
    </main>
  );
}

function ToolButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="rounded-lg border border-neutral-300 px-3 py-2 text-sm transition-opacity disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onPreview,
  onCommit,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onPreview: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="flex justify-between text-neutral-600">
        <span>{label}</span>
        <span>{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onPreview(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  );
}
