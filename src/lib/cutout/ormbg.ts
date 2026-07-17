// The ORMBG cutout provider — model inference via Transformers.js.
//
// ============================= LICENSING LANDMINE ==========================
// Do NOT swap in @imgly/background-removal. It is AGPL-3.0, and AGPL §13's
// network clause is triggered by serving software over a network — exactly
// what this product does. Shipping it would arguably oblige releasing this
// entire codebase; img.ly sell a commercial licence for precisely this
// reason. BRIA's RMBG-1.4 is non-commercial-only — also out. What's wired in
// is onnx-community/ormbg-ONNX (Open Remove Background Model), Apache-2.0.
// Check the licence of ANY model or vision library before adding it here —
// the popular ones are one line to use and warn you about nothing.
//
// It's also an IS-Net CNN rather than a vision transformer, which matters
// independently of licensing: transformer activation memory at photo
// resolution blows the WASM heap and crashes mobile Safari. A smaller model
// FILE does not imply smaller PEAK MEMORY.
// ===========================================================================
//
// UNVERIFIED: this inference call has never been run — it was written against
// the documented Transformers.js API in an environment that cannot reach
// huggingface.co. Everything downstream (refine.ts) is tested against real
// pixels; run THIS in a real browser and expect to fix something.
//
// Before launch, self-host the weights and set NEXT_PUBLIC_MODEL_BASE_URL:
// the default pulls them from a CDN you don't control, putting a third party
// in the critical path of every customer's first cutout — and letting them
// see your traffic.

import type { CutoutImageInput, CutoutProvider, RawMask } from './types';

const MODEL_ID = 'onnx-community/ormbg-ONNX';

// Minimal shape of what we use from Transformers.js. The real module is far
// bigger; these are the documented entry points this provider touches.
interface TransformersModule {
  AutoModel: { from_pretrained(id: string, opts?: unknown): Promise<TfModel> };
  AutoProcessor: { from_pretrained(id: string, opts?: unknown): Promise<TfProcessor> };
  RawImage: {
    fromCanvas(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<TfRawImage> | TfRawImage;
  };
  env: { remoteHost?: string; allowLocalModels?: boolean };
}
type TfModel = (inputs: Record<string, unknown>) => Promise<{ output: TfTensor }>;
interface TfProcessor {
  (image: TfRawImage): Promise<{ pixel_values: unknown }>;
}
interface TfTensor {
  data: Float32Array;
  dims: number[];
}
interface TfRawImage {
  width: number;
  height: number;
}

let modulePromise: Promise<TransformersModule | null> | null = null;

// @huggingface/transformers is an optionalDependency and the build must pass
// with it absent. The module name is assembled at runtime — an ugly trick,
// deliberately: webpack resolves static import() specifiers at build time and
// fails the build when the package is missing, which would make the optional
// dependency not optional.
//
// KNOWN WRINKLE for the first real run: because the specifier is hidden from
// the bundler, a BROWSER can't resolve it either — bare dynamic imports don't
// work without a bundler-visible path or an import map, so isAvailable() is
// currently false in browsers even with the package installed (the UI
// correctly hides the button; pinned by the browser pass). Enabling the
// feature for real means exposing the module to the browser: an import map
// entry, or a conditional bundled entry point that exists only when the
// package is installed. Solve that alongside the first inference run.
function loadTransformers(): Promise<TransformersModule | null> {
  if (!modulePromise) {
    const name = ['@huggingface', 'transformers'].join('/');
    modulePromise = (import(/* webpackIgnore: true */ name) as Promise<TransformersModule>).catch(
      () => null,
    );
  }
  return modulePromise;
}

export class OrmbgProvider implements CutoutProvider {
  readonly id = 'ormbg';
  private model: TfModel | null = null;
  private processor: TfProcessor | null = null;

  async isAvailable(): Promise<boolean> {
    return (await loadTransformers()) !== null;
  }

  async removeBackground(input: CutoutImageInput): Promise<RawMask> {
    const transformers = await loadTransformers();
    if (!transformers) {
      throw new Error(
        'Background removal is not installed. Run: npm install @huggingface/transformers',
      );
    }

    const baseUrl = process.env.NEXT_PUBLIC_MODEL_BASE_URL;
    if (baseUrl) {
      transformers.env.remoteHost = baseUrl;
    }

    if (!this.model || !this.processor) {
      // dtype fp32: ORMBG's quantised variants trade edge quality, and the
      // edge is exactly what a die cutter follows.
      this.model = (await transformers.AutoModel.from_pretrained(MODEL_ID, {
        dtype: 'fp32',
      })) as TfModel;
      this.processor = await transformers.AutoProcessor.from_pretrained(MODEL_ID);
    }

    // Round-trip through a canvas: Transformers.js wants a RawImage.
    const canvas = new OffscreenCanvas(input.width, input.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable.');
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(input.data), input.width, input.height),
      0,
      0,
    );
    const image = await transformers.RawImage.fromCanvas(canvas);

    const { pixel_values } = await this.processor(image);
    const { output } = await this.model({ input: pixel_values });

    // ORMBG emits a 1x1xHxW probability map at the MODEL'S resolution, not
    // the photo's. Nearest-neighbour resample back to source dimensions —
    // refinement then feathers, so nearest is fine and allocation-cheap.
    const dims = output.dims;
    const mh = dims[dims.length - 2]!;
    const mw = dims[dims.length - 1]!;
    const alpha = new Float32Array(input.width * input.height);
    for (let y = 0; y < input.height; y++) {
      const sy = Math.min(mh - 1, Math.floor((y / input.height) * mh));
      for (let x = 0; x < input.width; x++) {
        const sx = Math.min(mw - 1, Math.floor((x / input.width) * mw));
        alpha[y * input.width + x] = output.data[sy * mw + sx]!;
      }
    }

    return { alpha, width: input.width, height: input.height };
  }
}

export const ormbgProvider = new OrmbgProvider();
