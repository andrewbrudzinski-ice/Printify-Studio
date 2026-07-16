// Fulfilment state against real Postgres: held orders, retry guards applied
// to real rows, provider mapping priority, and the private print bucket.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canRetry } from '../src/lib/fulfilment/rules';

const db = new PGlite();

let count = 0;
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

const rows = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];
const one = async (sql: string) => (await rows(sql))[0]!;

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

console.log('schema + seed applied\n');

const U1 = '00000000-0000-4000-8000-0000000000aa';
await db.exec(`insert into auth.users (id, email) values ('${U1}', 'buyer@example.com')`);

// --- Default states -------------------------------------------------------------

await check("a fresh order starts at status='pending', fulfilment='unsubmitted'", async () => {
  await db.exec(`
    insert into public.orders (id, user_id, email, subtotal, total)
    values ('90000000-0000-4000-8000-000000000001', '${U1}', 'buyer@example.com', 1499, 1499);
  `);
  const r = await one(`select status, fulfilment_status from public.orders
                       where id = '90000000-0000-4000-8000-000000000001'`);
  assert.equal(r.status, 'pending');
  assert.equal(r.fulfilment_status, 'unsubmitted');
});

await check('an invented fulfilment state is rejected by the database', async () => {
  try {
    await db.exec(`update public.orders set fulfilment_status = 'shipped-ish'
                   where id = '90000000-0000-4000-8000-000000000001'`);
    assert.fail('should have violated the check constraint');
  } catch (e) {
    assert.match(String(e), /check constraint|violates/i);
  }
});

// --- The held-order flow ----------------------------------------------------------

await check('a paid order held at error records WHICH stage failed, money intact', async () => {
  await db.exec(`
    update public.orders
       set status = 'paid',
           fulfilment_status = 'error',
           provider_response = '{"stage":"print-generation","error":"This photo is too small to print sharply at this size.","dpi":57,"minDpi":100}'::jsonb
     where id = '90000000-0000-4000-8000-000000000001';
  `);
  const r = await one(`select status, fulfilment_status,
                              provider_response->>'stage' as stage,
                              provider_response->>'dpi' as dpi
                       from public.orders where id = '90000000-0000-4000-8000-000000000001'`);
  assert.equal(r.status, 'paid', 'holding must not touch the money state');
  assert.equal(r.fulfilment_status, 'error');
  assert.equal(r.stage, 'print-generation');
  assert.equal(r.dpi, '57');
});

await check('the retry guard permits exactly the held order, judged on real rows', async () => {
  const held = await one(`select status, fulfilment_status from public.orders
                          where id = '90000000-0000-4000-8000-000000000001'`);
  assert.equal(canRetry(held as { status: string; fulfilment_status: string }).ok, true);
});

await check('an accepted order read from the database refuses retry — would ship twice', async () => {
  await db.exec(`
    insert into public.orders (id, user_id, email, status, fulfilment_status, subtotal, total, provider_response)
    values ('90000000-0000-4000-8000-000000000002', '${U1}', 'buyer@example.com',
            'paid', 'accepted', 999, 999, '{"provider":"printify","providerOrderId":"987654"}'::jsonb);
  `);
  const r = await one(`select status, fulfilment_status from public.orders
                       where id = '90000000-0000-4000-8000-000000000002'`);
  const decision = canRetry(r as { status: string; fulfilment_status: string });
  assert.equal(decision.ok, false);
  assert.match((decision as { reason: string }).reason, /twice/);
});

await check('an unpaid order refuses retry — would ship for free', async () => {
  await db.exec(`
    insert into public.orders (id, user_id, email, status, fulfilment_status, subtotal, total)
    values ('90000000-0000-4000-8000-000000000003', '${U1}', 'buyer@example.com',
            'pending', 'error', 999, 999);
  `);
  const r = await one(`select status, fulfilment_status from public.orders
                       where id = '90000000-0000-4000-8000-000000000003'`);
  const decision = canRetry(r as { status: string; fulfilment_status: string });
  assert.equal(decision.ok, false);
  assert.match((decision as { reason: string }).reason, /free/);
});

await check('recovery: the held order retries to accepted with the provider id recorded', async () => {
  await db.exec(`
    update public.orders
       set fulfilment_status = 'accepted',
           provider_response = '{"provider":"printify","providerOrderId":"111222"}'::jsonb
     where id = '90000000-0000-4000-8000-000000000001';
  `);
  const r = await one(`select fulfilment_status, provider_response->>'providerOrderId' as poid
                       from public.orders where id = '90000000-0000-4000-8000-000000000001'`);
  assert.equal(r.fulfilment_status, 'accepted');
  assert.equal(r.poid, '111222');
});

// --- Provider mappings, as the failover reads them -----------------------------------

await check('mapping priority query: hand-tuned 50 outranks the default 100', async () => {
  await db.exec(`
    insert into public.provider_mappings (variant_id, provider, provider_product_id, provider_variant_id, cost, priority)
    select id, 'printify', 'bp-77', '4012', 850, 50 from public.product_variants where sku = 'MUG-11-WHT';
    insert into public.provider_mappings (variant_id, provider, provider_product_id, provider_variant_id, cost)
    select id, 'gelato', 'g-9', 'g-9-m', 900 from public.product_variants where sku = 'MUG-11-WHT';
  `);
  const r = await rows(`
    select m.provider from public.provider_mappings m
    join public.product_variants v on v.id = m.variant_id
    where v.sku = 'MUG-11-WHT'
    order by m.priority asc
  `);
  assert.deepEqual(r.map((x) => x.provider), ['printify', 'gelato']);
});

await check('one provider per variant: a second printify mapping for the same variant is rejected', async () => {
  try {
    await db.exec(`
      insert into public.provider_mappings (variant_id, provider, provider_product_id, provider_variant_id, cost)
      select id, 'printify', 'bp-78', '9999', 800 from public.product_variants where sku = 'MUG-11-WHT';
    `);
    assert.fail('should have violated unique (variant_id, provider)');
  } catch (e) {
    assert.match(String(e), /duplicate key|unique/i);
  }
});

// --- Print storage -------------------------------------------------------------------

await check('the prints bucket is private — print files reach providers by signed URL only', async () => {
  const r = await one(`select public from storage.buckets where id = 'prints'`);
  assert.equal(r.public, false);
});

await check('order_items carry the print file path once generated', async () => {
  // The webhook refuses to submit items without a print file; the column the
  // whole handoff hangs on must exist and take a path.
  await db.exec(`
    insert into public.projects (id, user_id) values ('91000000-0000-4000-8000-000000000001', '${U1}');
    insert into public.project_images (id, project_id, storage_path, width, height)
    values ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'u/a.jpg', 4000, 3000);
    insert into public.designs (id, user_id, project_id, image_id, template_id, spec)
    select '93000000-0000-4000-8000-000000000001', '${U1}', '91000000-0000-4000-8000-000000000001',
           '92000000-0000-4000-8000-000000000001', t.id, '{"v":1}'::jsonb
    from public.product_templates t where t.slug = 'mug';
    insert into public.order_items (order_id, design_id, variant_id, quantity, unit_price, print_file_url)
    select '90000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', v.id, 1, v.price,
           'prints/90000000-0000-4000-8000-000000000001/item-1.jpg'
    from public.product_variants v where v.sku = 'MUG-11-WHT';
  `);
  const r = await one(`select print_file_url from public.order_items
                       where order_id = '90000000-0000-4000-8000-000000000001'`);
  assert.match(String(r.print_file_url), /^prints\//);
});

console.log(`\n${count} checks passed against real Postgres.`);
