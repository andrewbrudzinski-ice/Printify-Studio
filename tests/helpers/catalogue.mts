// Load the REAL seed catalogue by applying supabase/schema.sql + the seed
// migration to in-process Postgres. Tests that consume this run against the
// exact data production will read — not a fixture that can drift from it.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export interface CatalogueVariant {
  sku: string;
  price: number;
  config: unknown;
}

export interface CatalogueTemplate {
  slug: string;
  config: unknown;
  mockup_layers: unknown[];
  variants: CatalogueVariant[];
}

export async function loadCatalogue(): Promise<CatalogueTemplate[]> {
  const db = new PGlite();
  // Stub what Supabase provides around the schema (see flow.integration.mjs).
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
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

  const templates = (
    await db.query<{ id: string; slug: string; config: unknown; mockup_layers: unknown[] }>(
      `select id, slug, config, mockup_layers from public.product_templates order by sort_order`,
    )
  ).rows;

  const variants = (
    await db.query<{ template_id: string; sku: string; price: number; config: unknown }>(
      `select template_id, sku, price, config from public.product_variants order by sku`,
    )
  ).rows;

  await db.close();

  return templates.map((t) => ({
    slug: t.slug,
    config: t.config,
    mockup_layers: t.mockup_layers,
    variants: variants
      .filter((v) => v.template_id === t.id)
      .map((v) => ({ sku: v.sku, price: v.price, config: v.config })),
  }));
}
