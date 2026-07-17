// Regenerate the demo catalogue JSON from the REAL seed. The demo file is a
// build artifact of the seed, never hand-edited — tests/demo.test.mts fails
// the suite if the two drift.
//
//   npx tsx scripts/build-demo-catalogue.mts
//
// Why this exists: with zero env vars there is no database, but the funnel
// must still demo (upload -> grid -> editor -> cart). The catalogue and
// bundles routes serve this snapshot when Supabase is unconfigured.
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
`);
await db.exec(readFileSync('supabase/schema.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/0002_seed_templates.sql', 'utf8'));

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  config: unknown;
  mockup_layers: unknown[];
}
interface VariantRow {
  template_id: string;
  sku: string;
  name: string;
  price: number;
  config: unknown;
}

const templates = (
  await db.query<TemplateRow>(
    `select id, slug, name, description, config, mockup_layers
     from public.product_templates where active order by sort_order`,
  )
).rows;
const variants = (
  await db.query<VariantRow>(
    `select template_id, sku, name, price, config
     from public.product_variants where active order by sku`,
  )
).rows;
const bundles = (
  await db.query(
    `select id, skus, quantity, reward, priority from public.bundles where active order by priority desc`,
  )
).rows;
await db.close();

const out = {
  generatedFrom: 'supabase/migrations/0002_seed_templates.sql',
  templates: templates.map((t) => ({
    slug: t.slug,
    name: t.name,
    description: t.description,
    config: t.config,
    mockupLayers: t.mockup_layers,
    variants: variants
      .filter((v) => v.template_id === t.id)
      .map((v) => ({ sku: v.sku, name: v.name, price: v.price, config: v.config })),
  })),
  bundles,
};

writeFileSync('src/lib/studio/demoCatalogue.json', JSON.stringify(out, null, 2) + '\n');
console.log(`demo catalogue written: ${out.templates.length} templates, ${bundles.length} bundles`);
