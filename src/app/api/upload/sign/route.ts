// POST /api/upload/sign — creates the project + image rows and returns a
// signed upload URL token. The client decodes the photo locally first (it
// knows the dimensions) and uploads in the background; the grid never waits
// on this route.
//
// Anonymous uploads are allowed ON PURPOSE: demanding a signup before anyone
// has seen a mockup kills the funnel. Anonymous work is namespaced under
// anon/<token>/ and claimed at signup by claim_anon_projects().

import { NextResponse } from 'next/server';
import { supabaseRoute } from '@/lib/supabase/route';
import { supabaseService } from '@/lib/supabase/service';

export const runtime = 'nodejs';

interface SignBody {
  width: number;
  height: number;
  contentType: string;
  anonToken?: string;
}

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function POST(req: Request): Promise<NextResponse> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Uploads are not configured.' }, { status: 503 });
  }

  let body: SignBody;
  try {
    body = (await req.json()) as SignBody;
  } catch {
    return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(body.contentType)) {
    return NextResponse.json(
      { error: 'Upload a JPEG, PNG or WebP photo.' },
      { status: 400 },
    );
  }
  if (
    !Number.isInteger(body.width) || !Number.isInteger(body.height) ||
    body.width < 1 || body.height < 1 || body.width > 20000 || body.height > 20000
  ) {
    return NextResponse.json({ error: 'Send the decoded photo dimensions.' }, { status: 400 });
  }

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
  const ext = body.contentType === 'image/png' ? 'png' : body.contentType === 'image/webp' ? 'webp' : 'jpg';
  const namespace = user ? `user/${user.id}` : `anon/${body.anonToken}`;
  const path = `${namespace}/${crypto.randomUUID()}.${ext}`;

  const { data: project, error: projectErr } = await db
    .from('projects')
    .insert(user ? { user_id: user.id } : { anon_token: body.anonToken })
    .select('id')
    .single();
  if (projectErr || !project) {
    return NextResponse.json({ error: 'Could not start a project. Try again.' }, { status: 500 });
  }
  const projectId = (project as { id: string }).id;

  const { data: image, error: imageErr } = await db
    .from('project_images')
    .insert({ project_id: projectId, storage_path: path, width: body.width, height: body.height })
    .select('id')
    .single();
  if (imageErr || !image) {
    return NextResponse.json({ error: 'Could not register the photo. Try again.' }, { status: 500 });
  }

  const { data: signed, error: signErr } = await db.storage
    .from('uploads')
    .createSignedUploadUrl(path);
  if (signErr || !signed) {
    return NextResponse.json({ error: 'Could not prepare the upload. Try again.' }, { status: 500 });
  }

  return NextResponse.json({
    imageId: (image as { id: string }).id,
    projectId,
    path,
    token: signed.token,
  });
}
