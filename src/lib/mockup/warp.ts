// Affine triangle mapping for mesh warps. Pure math, no canvas — testable to
// numeric precision on its own.

export type Vec2 = [number, number];
export type Triangle = [Vec2, Vec2, Vec2];

export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// How far each destination-triangle edge is pushed outward so adjacent
// triangles overlap instead of meeting at an antialiased hairline seam.
// Sub-pixel is enough: the neighbour's own pad covers the other half.
export const SEAM_PAD = 0.75;

// Solve the affine transform mapping src triangle -> dst triangle:
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
// Returns null for a degenerate (zero-area) source triangle — the caller
// skips that triangle rather than drawing garbage.
export function affineFromTriangles(src: Triangle, dst: Triangle): Affine | null {
  const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = src;
  const [[dx0, dy0], [dx1, dy1], [dx2, dy2]] = dst;

  const det = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(det) < 1e-12) return null;

  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / det;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / det;
  const e =
    (dx0 * (sx1 * sy2 - sx2 * sy1) +
      dx1 * (sx2 * sy0 - sx0 * sy2) +
      dx2 * (sx0 * sy1 - sx1 * sy0)) /
    det;

  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / det;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / det;
  const f =
    (dy0 * (sx1 * sy2 - sx2 * sy1) +
      dy1 * (sx2 * sy0 - sx0 * sy2) +
      dy2 * (sx0 * sy1 - sx1 * sy0)) /
    det;

  return { a, b, c, d, e, f };
}

// Expand a triangle by `pad`: offset each EDGE along its own outward normal,
// then re-intersect adjacent edges to recover the vertices.
//
// Why edges and not vertices: the first seam fix pushed vertices out from the
// centroid, and for the sliver triangles a dense cylindrical mesh produces
// near the silhouette, the centroid sits almost ON the long edge — so that
// edge barely moved and the seams survived. Offsetting each edge by its own
// normal moves every edge by exactly `pad` regardless of triangle shape.
// tests/mockup.test.mts pins this with solid artwork on a dense sliver mesh.
export function expandTriangle(tri: Triangle, pad: number): Triangle {
  // Offset line for edge i (from tri[i] to tri[i+1]): a point on it + its dir.
  const origins: Vec2[] = [];
  const dirs: Vec2[] = [];

  for (let i = 0; i < 3; i++) {
    const A = tri[i] as Vec2;
    const B = tri[(i + 1) % 3] as Vec2;
    const C = tri[(i + 2) % 3] as Vec2; // opposite vertex

    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) {
      // Degenerate edge — no meaningful normal; leave the line in place.
      origins.push([A[0], A[1]]);
      dirs.push([dx, dy]);
      continue;
    }

    // Perpendicular, then flip if it points toward the opposite vertex.
    let nx = dy / len;
    let ny = -dx / len;
    if (nx * (C[0] - A[0]) + ny * (C[1] - A[1]) > 0) {
      nx = -nx;
      ny = -ny;
    }

    origins.push([A[0] + nx * pad, A[1] + ny * pad]);
    dirs.push([dx, dy]);
  }

  // Vertex i sits on edge (i-1) and edge i; intersect their offset lines.
  const out: Vec2[] = [];
  for (let i = 0; i < 3; i++) {
    const prev = (i + 2) % 3;
    const o1 = origins[prev] as Vec2;
    const d1 = dirs[prev] as Vec2;
    const o2 = origins[i] as Vec2;
    const d2 = dirs[i] as Vec2;

    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-12) {
      // Nearly-parallel edges (degenerate triangle): keep the original vertex.
      out.push([(tri[i] as Vec2)[0], (tri[i] as Vec2)[1]]);
      continue;
    }
    const t = ((o2[0] - o1[0]) * d2[1] - (o2[1] - o1[1]) * d2[0]) / cross;
    out.push([o1[0] + t * d1[0], o1[1] + t * d1[1]]);
  }

  return out as Triangle;
}
