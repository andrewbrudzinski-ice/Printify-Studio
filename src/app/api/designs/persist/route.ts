// POST /api/designs/persist — turns local cart items into real design rows,
// called once at checkout. Returns design ids POSITIONALLY aligned with the
// posted items; the client forwards them to /api/stripe/checkout in the same
// order. Position is identity end to end — see src/lib/checkout/mapping.ts.
//
// Anonymous carts are first-class: the caller proves ownership of anonymous
// work with the anon token, exactly like claim_anon_projects().

import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase/service';
import { supabaseRoute } from '@/lib/supabase/route';
import { parseDesignSpec } from '@/lib/mockup/spec';

export const runtime = 'nodejs';

interface PersistItem {
  imageId: string;
  templateSlug: string;
  spec: unknown;
}

interface PersistBody {
  items: PersistItem[];
  anonToken?: string;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Designs cannot be saved on this deployment.' }, { status: 503 });
  }

  let body: PersistBody;
  try {
    body = (await req.json()) as PersistBody;
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'Send at least one item.' }, { status: 400 });
  }

  // Who is calling? A signed-in user (from the auth cookie) or an anonymous
  // visitor (anon token). Both are legitimate; neither may touch the other's
  // images.
  const rls = await supabaseRoute();
  const {
    data: { user },
  } = await rls.auth.getUser();
  if (!user && !body.anonToken) {
    return NextResponse.json(
      { error: 'Sign in, or include the anonymous session token.' },
      { status: 401 },
    );
  }

  const db = supabaseService();

  // Validate specs up front — reject the whole batch on the first bad one so
  // the client can't end up with half a cart persisted. Parsed specs are kept
  // positionally for the insert below.
  const specs: unknown[] = [];
  for (let i = 0; i < body.items.length; i++) {
    const parsed = parseDesignSpec(body.items[i]!.spec);
    if (!parsed.ok) {
      return NextResponse.json({ error: `Item ${i + 1}: ${parsed.error}` }, { status: 400 });
    }
    specs.push(parsed.spec);
  }

  // Resolve templates and verify image ownership.
  const slugs = [...new Set(body.items.map((i) => i.templateSlug))];
  const { data: templates } = await db
    .from('product_templates')
    .select('id, slug')
    .in('slug', slugs);
  const templateBySlug = new Map(
    ((templates ?? []) as Array<{ id: string; slug: string }>).map((t) => [t.slug, t.id]),
  );

  const imageIds = [...new Set(body.items.map((i) => i.imageId))];
  const { data: images } = await db
    .from('project_images')
    .select('id, project_id, projects!inner(id, user_id, anon_token)')
    .in('id', imageIds);
  const imageById = new Map(
    // Same untyped-client join quirk as the checkout route: many-to-one
    // arrives as an object despite the inferred array type.
    ((images ?? []) as unknown as Array<{
      id: string;
      project_id: string;
      projects: { user_id: string | null; anon_token: string | null };
    }>).map((img) => [img.id, img]),
  );

  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i]!;
    const templateId = templateBySlug.get(item.templateSlug);
    if (!templateId) {
      return NextResponse.json(
        { error: `Item ${i + 1}: unknown product "${item.templateSlug}".` },
        { status: 400 },
      );
    }
    const image = imageById.get(item.imageId);
    const owned =
      image &&
      ((user && image.projects.user_id === user.id) ||
        (body.anonToken && image.projects.anon_token === body.anonToken));
    if (!owned) {
      // Same response for "doesn't exist" and "not yours": this endpoint must
      // not confirm which image ids exist.
      return NextResponse.json(
        { error: `Item ${i + 1}: that photo is not available. Upload it again.` },
        { status: 403 },
      );
    }
    rows.push({
      user_id: user?.id ?? null,
      project_id: image.project_id,
      image_id: image.id,
      template_id: templateId,
      spec: specs[i],
    });
  }

  // One insert, ids returned in row order — the positional contract the
  // client relies on when it forwards these to /api/stripe/checkout.
  const { data: inserted, error } = await db.from('designs').insert(rows).select('id');
  if (error || !inserted || inserted.length !== rows.length) {
    return NextResponse.json({ error: 'Could not save your designs. Try again.' }, { status: 500 });
  }

  return NextResponse.json({
    designIds: (inserted as Array<{ id: string }>).map((r) => r.id),
  });
}
