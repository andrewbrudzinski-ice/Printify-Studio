// POST /api/cutout — deliberately empty. Cutouts run in the BROWSER today
// (zero marginal cost, no latency budget, the user's photo never leaves their
// device before they decide to buy). The schema already carries
// project_images.cutout_status / cutout_path for the day this moves
// server-side; until then this route exists so the path is reserved and the
// answer is honest.

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'Cutouts run in the browser. This endpoint is reserved for a server-side pipeline.' },
    { status: 501 },
  );
}
