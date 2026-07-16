// The demo catalogue is a build artifact of the seed, never a second source
// of truth. This suite regenerates the comparison data from the REAL seed
// and fails if the committed JSON has drifted — the demo funnel and the
// production catalogue must be the same products.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import demo from '../src/lib/studio/demoCatalogue.json';
import { loadCatalogue } from './helpers/catalogue.mts';
import { PGlite } from '@electric-sql/pglite';

let count = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    count += 1;
    console.log(`  ok  ${label}`);
  });
}

const catalogue = await loadCatalogue();

await check('demo templates match the seed: slugs, order-independent', async () => {
  assert.deepEqual(
    [...demo.templates.map((t) => t.slug)].sort(),
    [...catalogue.map((t) => t.slug)].sort(),
  );
});

await check('demo layer stacks are byte-identical to the seed', async () => {
  for (const t of catalogue) {
    const demoT = demo.templates.find((x) => x.slug === t.slug)!;
    assert.deepEqual(demoT.mockupLayers, t.mockup_layers, `${t.slug}: layers drifted`);
    assert.deepEqual(demoT.config, t.config, `${t.slug}: config drifted`);
  }
});

await check('demo variants match the seed: SKUs and prices', async () => {
  for (const t of catalogue) {
    const demoT = demo.templates.find((x) => x.slug === t.slug)!;
    assert.deepEqual(
      demoT.variants.map((v) => [v.sku, v.price]).sort(),
      t.variants.map((v) => [v.sku, v.price]).sort(),
      `${t.slug}: variants drifted`,
    );
  }
});

await check('demo bundles match the seed exactly', async () => {
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
  const seeded = (
    await db.query(
      `select id, skus, quantity, reward, priority from public.bundles where active order by priority desc`,
    )
  ).rows;
  await db.close();
  assert.deepEqual(demo.bundles, seeded, 'bundles drifted — rerun scripts/build-demo-catalogue.mts');
});

console.log(`\n${count} checks passed — demo snapshot matches the seed.`);
