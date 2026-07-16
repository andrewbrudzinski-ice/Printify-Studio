// Background removal — the contract.
//
// The provider choice is a LEGAL decision as much as a technical one (see the
// licensing landmine in ormbg.ts — this is the kind of decision a lawyer
// overrules an engineer on), so it lives behind CutoutProvider. Swapping to a
// paid API is a new class, not a refactor.

export interface RawMask {
  // Per-pixel foreground probability, 0..1, row-major, width*height long.
  // This is what a segmentation model emits; it is NEVER print-ready — see
  // refine.ts for why raw alpha on a physical product fails.
  alpha: Float32Array;
  width: number;
  height: number;
}

export interface MaskBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RefinedCutout {
  // Print-ready alpha, 0..255, compositable straight into a canvas.
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
  bbox: MaskBox;
  // Fraction of pixels kept — recorded so the UI can explain a result.
  coverage: number;
}

export interface CutoutImageInput {
  data: Uint8ClampedArray; // RGBA, as from getImageData
  width: number;
  height: number;
}

export interface CutoutProvider {
  readonly id: string;
  // False hides the feature entirely (no button, no error). An optional
  // dependency that breaks the app when missing is not optional.
  isAvailable(): Promise<boolean>;
  removeBackground(input: CutoutImageInput): Promise<RawMask>;
}

// A cutout that would print badly is rejected, not shipped: a customer pays
// for a keychain of their dog and must not receive a keychain of a grey blob.
export class CutoutQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoutQualityError';
  }
}

// Detect by name, never instanceof — a module instantiated twice (split
// chunks, server/client, some test runners) makes instanceof return false on
// an error with a correct prototype chain. This exact failure shipped a
// generic crash instead of "try a photo with more contrast".
export function isCutoutQualityError(e: unknown): e is CutoutQualityError {
  return (
    typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'CutoutQualityError'
  );
}
