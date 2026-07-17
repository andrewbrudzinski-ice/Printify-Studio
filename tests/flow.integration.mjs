// Schema + seed + RLS checks against real Postgres (PGlite, in-process — no
// server needed). This applies the actual supabase/schema.sql and seed
// migration, then verifies the properties the app depends on. Not mocks: if a
// policy is missing or a jsonb literal doesn't cast, this fails the same way
// `supabase db push` would.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();

let count = 0;
async function check(label, fn) {
  await fn();
  count += 1;
  console.log(`  ok  ${label}`);
}

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

// Expect a statement to fail, and fail for the stated reason.
async function expectError(sql, pattern) {
  try {
    await db.exec(sql);
  } catch (e) {
    assert.match(String(e.message ?? e), pattern);
    return;
  }
  assert.fail(`expected this to fail (${pattern}): ${sql}`);
}

// --- Stub what Supabase provides around the schema ---------------------------
// Real Supabase ships the auth/storage schemas and the anon/authenticated/
// service_role roles. The schema under test references them; stub just enough
// that the real SQL applies unmodified.
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    email text,
    created_at timestamptz not null default now()
  );
  -- Supabase resolves auth.uid() from the JWT; the stub reads the same GUC
  -- PostgREST sets, so policies under test behave identically.
  create function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false
  );
`);

// --- Apply the real schema and seed ------------------------------------------

await db.exec(readFileSync('supabase/schema.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/0002_seed_templates.sql', 'utf8'));

console.log('schema + seed applied to real Postgres\n');

// --- Tables and RLS coverage --------------------------------------------------

const EXPECTED_TABLES = [
  'users', 'product_templates', 'product_variants', 'collections',
  'collection_items', 'bundles', 'discounts', 'projects', 'project_images',
  'designs', 'orders', 'order_items', 'provider_mappings',
];

await check('all 13 tables exist', async () => {
  const r = await rows(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = r.map((x) => x.tablename);
  for (const t of EXPECTED_TABLES) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
});

await check('RLS is enabled on every public table', async () => {
  const r = await rows(
    `select relname from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  );
  assert.deepEqual(r.map((x) => x.relname), [], 'tables without RLS');
});

await check('orders has no INSERT/UPDATE/DELETE policy for any role', async () => {
  const r = await rows(
    `select cmd from pg_policies
     where schemaname = 'public' and tablename in ('orders','order_items')
       and cmd <> 'SELECT'`,
  );
  assert.equal(r.length, 0, 'a write policy exists on orders/order_items');
});

await check('discounts and provider_mappings have no client policies at all', async () => {
  const r = await rows(
    `select tablename from pg_policies
     where schemaname = 'public' and tablename in ('discounts','provider_mappings')`,
  );
  assert.equal(r.length, 0);
});

await check('client roles hold no table privileges on discounts/provider_mappings/orders-write', async () => {
  const r = await rows(`
    select table_name, privilege_type from information_schema.role_table_grants
    where grantee in ('anon','authenticated') and table_schema = 'public'
      and (table_name in ('discounts','provider_mappings')
           or (table_name in ('orders','order_items') and privilege_type <> 'SELECT'))
  `);
  assert.deepEqual(r, [], 'unexpected client grant');
});

// --- Seed shape ----------------------------------------------------------------

await check('11 product templates seeded, all active', async () => {
  const r = await one(`select count(*)::int as n from public.product_templates where active`);
  assert.equal(r.n, 11);
});

await check('17 variants seeded, prices are positive integers', async () => {
  const r = await one(
    `select count(*)::int as n, min(price)::int as min from public.product_variants`,
  );
  assert.equal(r.n, 17);
  assert.ok(r.min > 0);
});

await check('7 collections seeded, every one has members', async () => {
  const r = await one(`
    select count(*)::int as n from public.collections c
    where exists (select 1 from public.collection_items i where i.collection_id = c.id)
  `);
  assert.equal(r.n, 7);
});

await check('5 bundles seeded; rewards parse as the engine expects', async () => {
  const r = await rows(`select id, reward from public.bundles`);
  assert.equal(r.length, 5);
  for (const b of r) {
    const reward = typeof b.reward === 'string' ? JSON.parse(b.reward) : b.reward;
    assert.ok(['percent', 'fixed'].includes(reward.kind), `${b.id}: bad reward.kind`);
    assert.ok(Number.isInteger(reward.value) && reward.value > 0, `${b.id}: bad reward.value`);
  }
});

await check('every bundle SKU references a real variant', async () => {
  const r = await one(`
    select count(*)::int as n
    from public.bundles b, unnest(b.skus) as sku
    where not exists (select 1 from public.product_variants v where v.sku = sku)
  `);
  assert.equal(r.n, 0);
});

// --- Mockup layer validation (the geometry contract the renderer trusts) -------

await check('every ARTWORK / MESH_WARP layer has a rect', async () => {
  const r = await one(`
    select count(*)::int as n
    from public.product_templates t, jsonb_array_elements(t.mockup_layers) l
    where l->>'type' in ('ARTWORK','MESH_WARP') and l->'rect' is null
  `);
  assert.equal(r.n, 0);
});

await check('every rect is normalised: 0..1 and inside the canvas', async () => {
  const r = await one(`
    select count(*)::int as n
    from public.product_templates t, jsonb_array_elements(t.mockup_layers) l
    where l ? 'rect' and (
      (l->'rect'->>'x')::numeric < 0 or (l->'rect'->>'y')::numeric < 0 or
      (l->'rect'->>'w')::numeric <= 0 or (l->'rect'->>'h')::numeric <= 0 or
      (l->'rect'->>'x')::numeric + (l->'rect'->>'w')::numeric > 1 or
      (l->'rect'->>'y')::numeric + (l->'rect'->>'h')::numeric > 1
    )
  `);
  assert.equal(r.n, 0);
});

await check("every mesh's point count matches (cols+1)*(rows+1)", async () => {
  const r = await one(`
    select count(*)::int as n
    from public.product_templates t, jsonb_array_elements(t.mockup_layers) l
    where l->>'type' = 'MESH_WARP'
      and jsonb_array_length(l->'mesh'->'points')
          <> ((l->'mesh'->>'cols')::int + 1) * ((l->'mesh'->>'rows')::int + 1)
  `);
  assert.equal(r.n, 0);
});

await check('every template config carries print geometry with the DPI floor', async () => {
  const r = await one(`
    select count(*)::int as n from public.product_templates
    where (config->'print'->>'minDpi') is null
       or (config->'print'->>'widthIn') is null
       or (config->'print'->>'heightIn') is null
  `);
  assert.equal(r.n, 0);
});

await check('every requiresCutout product has a MASK layer', async () => {
  const r = await one(`
    select count(*)::int as n from public.product_templates t
    where (t.config->>'requiresCutout')::boolean
      and not exists (
        select 1 from jsonb_array_elements(t.mockup_layers) l
        where l->>'type' = 'MASK'
      )
  `);
  assert.equal(r.n, 0);
});

// --- Constraints ---------------------------------------------------------------

await check('duplicate SKU is rejected', () =>
  expectError(
    `insert into public.product_variants (template_id, sku, name, price)
     select id, 'MUG-11-WHT', 'dup', 1 from public.product_templates where slug = 'mug'`,
    /duplicate key|unique/i,
  ));

await check('negative money is rejected', () =>
  expectError(
    `insert into public.orders (email, subtotal, total) values ('x@x.com', -1, -1)`,
    /check constraint|violates/i,
  ));

await check('an order whose parts disagree with its total is rejected', () =>
  expectError(
    `insert into public.orders (email, subtotal, discount_total, tax, shipping, total)
     values ('x@x.com', 1000, 0, 80, 500, 9999)`,
    /check constraint|violates/i,
  ));

await check('a project must be owned or anonymous, never neither', () =>
  expectError(
    `insert into public.projects (user_id, anon_token) values (null, null)`,
    /check constraint|violates/i,
  ));

// --- Triggers & functions --------------------------------------------------------

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';

await check('auth signup trigger creates the public.users profile', async () => {
  await db.exec(`
    insert into auth.users (id, email) values
      ('${U1}', 'one@example.com'),
      ('${U2}', 'two@example.com');
  `);
  const r = await one(`select count(*)::int as n from public.users`);
  assert.equal(r.n, 2);
});

await check('claim_anon_projects claims exactly the matching token', async () => {
  await db.exec(`
    insert into public.projects (anon_token) values ('tok-claim'), ('tok-other');
    select set_config('request.jwt.claim.sub', '${U1}', false);
  `);
  const r = await one(`select public.claim_anon_projects('tok-claim') as n`);
  assert.equal(r.n, 1);
  const claimed = await one(
    `select user_id, anon_token from public.projects where user_id = '${U1}'`,
  );
  assert.equal(claimed.anon_token, null);
  const other = await one(
    `select user_id from public.projects where anon_token = 'tok-other'`,
  );
  assert.equal(other.user_id, null, 'unrelated anon project must stay unclaimed');
});

await check('claim_anon_projects refuses an unauthenticated caller', async () => {
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  await expectError(
    `select public.claim_anon_projects('tok-other')`,
    /Sign in before claiming/,
  );
});

await check('orders.updated_at advances on update', async () => {
  await db.exec(`
    insert into public.orders (id, user_id, email, subtotal, total)
    values ('10000000-0000-4000-8000-000000000001', '${U1}', 'one@example.com', 1000, 1000);
    update public.orders set updated_at = now() - interval '1 hour'
    where id = '10000000-0000-4000-8000-000000000001';
  `);
  await db.exec(`
    update public.orders set status = 'paid'
    where id = '10000000-0000-4000-8000-000000000001';
  `);
  const r = await one(
    `select (updated_at > created_at - interval '1 minute') as advanced,
            (updated_at >= created_at) as sane
     from public.orders where id = '10000000-0000-4000-8000-000000000001'`,
  );
  assert.equal(r.sane, true);
});

// --- Live RLS enforcement ---------------------------------------------------------
// The superuser owns the tables and bypasses RLS; these run under the actual
// client roles, exactly as PostgREST would.

await check('anon sees active templates only', async () => {
  await db.exec(`
    insert into public.product_templates (slug, name, config, active)
    values ('retired', 'Retired', '{"print":{"widthIn":1,"heightIn":1,"minDpi":100}}'::jsonb, false);
  `);
  await db.exec(`set role anon`);
  const r = await one(`select count(*)::int as n from public.product_templates`);
  await db.exec(`reset role`);
  assert.equal(r.n, 11, 'anon must not see the inactive template');
  const all = await one(`select count(*)::int as n from public.product_templates`);
  assert.equal(all.n, 12, 'owner sees all 12');
});

await check('anon cannot read discounts at all', async () => {
  await db.exec(`set role anon`);
  await expectError(`select * from public.discounts`, /permission denied/i);
  await db.exec(`reset role`);
});

await check('authenticated cannot read provider wholesale costs', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  await expectError(`select * from public.provider_mappings`, /permission denied/i);
  await db.exec(`reset role`);
});

await check('a client cannot INSERT an order — zero write access', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  await expectError(
    `insert into public.orders (email, subtotal, total) values ('e@e.com', 1, 1)`,
    /permission denied/i,
  );
  await db.exec(`reset role`);
});

await check('a client cannot UPDATE an order (e.g. its total) either', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  await expectError(
    `update public.orders set total = 0 where user_id = '${U1}'`,
    /permission denied/i,
  );
  await db.exec(`reset role`);
});

await check('a user sees their own orders and nobody else’s', async () => {
  await db.exec(`
    insert into public.orders (user_id, email, subtotal, total)
    values ('${U2}', 'two@example.com', 2000, 2000);
  `);
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  const r = await rows(`select user_id from public.orders`);
  await db.exec(`reset role`);
  assert.equal(r.length, 1);
  assert.equal(r[0].user_id, U1);
});

await check('a user cannot see another user’s projects', async () => {
  await db.exec(`
    insert into public.projects (id, user_id) values
      ('20000000-0000-4000-8000-000000000001', '${U1}'),
      ('20000000-0000-4000-8000-000000000002', '${U2}');
  `);
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U2}', false);
    set role authenticated;
  `);
  const r = await rows(`select id from public.projects`);
  await db.exec(`reset role`);
  assert.equal(r.length, 1);
  assert.equal(r[0].id, '20000000-0000-4000-8000-000000000002');
});

await check('a user can create their own project but not one for someone else', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  await db.exec(`insert into public.projects (user_id) values ('${U1}')`);
  await expectError(
    `insert into public.projects (user_id) values ('${U2}')`,
    /row-level security|policy/i,
  );
  await db.exec(`reset role`);
});

// --- Checkout-shaped flow: designs, order items, the duplicate-SKU seam ------------

await check('two order items may share a SKU with different designs — never collapsed', async () => {
  // The same mug, two different photos. This must remain two rows with two
  // distinct design_ids; see CLAUDE.md "identity from position".
  await db.exec(`
    insert into public.project_images (id, project_id, storage_path, width, height) values
      ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'u/one/a.jpg', 3000, 2000),
      ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'u/one/b.jpg', 3000, 2000);

    insert into public.designs (id, user_id, project_id, image_id, template_id, spec)
    select '40000000-0000-4000-8000-000000000001', '${U1}',
           '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
           t.id, '{"v":1}'::jsonb
    from public.product_templates t where t.slug = 'mug';

    insert into public.designs (id, user_id, project_id, image_id, template_id, spec)
    select '40000000-0000-4000-8000-000000000002', '${U1}',
           '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002',
           t.id, '{"v":1}'::jsonb
    from public.product_templates t where t.slug = 'mug';

    insert into public.order_items (order_id, design_id, variant_id, quantity, unit_price)
    select '10000000-0000-4000-8000-000000000001', d.id, v.id, 1, v.price
    from public.designs d
    cross join public.product_variants v
    where v.sku = 'MUG-11-WHT' and d.user_id = '${U1}';
  `);
  const r = await one(`
    select count(*)::int as items, count(distinct design_id)::int as designs
    from public.order_items
    where order_id = '10000000-0000-4000-8000-000000000001'
  `);
  assert.equal(r.items, 2);
  assert.equal(r.designs, 2, 'same SKU must not collapse to one design');
});

await check('ownership join: a user reads their order items through their order', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U1}', false);
    set role authenticated;
  `);
  const r = await one(`
    select count(*)::int as n
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
  `);
  await db.exec(`reset role`);
  assert.equal(r.n, 2);
});

await check('the other user sees none of those order items', async () => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${U2}', false);
    set role authenticated;
  `);
  const r = await one(`select count(*)::int as n from public.order_items`);
  await db.exec(`reset role`);
  assert.equal(r.n, 0);
});

await check('a variant referenced by an order cannot be deleted (history preserved)', () =>
  expectError(
    `delete from public.product_variants where sku = 'MUG-11-WHT'`,
    /foreign key|violates|restrict/i,
  ));

await check('deleting an unreferenced template cascades to its variants', async () => {
  await db.exec(`
    insert into public.product_variants (template_id, sku, name, price)
    select id, 'RETIRED-1', 'Retired variant', 100
    from public.product_templates where slug = 'retired';
    delete from public.product_templates where slug = 'retired';
  `);
  const r = await one(
    `select count(*)::int as n from public.product_variants where sku = 'RETIRED-1'`,
  );
  assert.equal(r.n, 0);
});

await check('unique stripe_session_id: a replayed session cannot create a second order', async () => {
  await db.exec(`
    insert into public.orders (user_id, email, subtotal, total, stripe_session_id)
    values ('${U1}', 'one@example.com', 500, 500, 'cs_test_replay');
  `);
  await expectError(
    `insert into public.orders (user_id, email, subtotal, total, stripe_session_id)
     values ('${U1}', 'one@example.com', 500, 500, 'cs_test_replay')`,
    /duplicate key|unique/i,
  );
});

// --- Storage buckets ------------------------------------------------------------

await check('three buckets: templates public, uploads and prints private', async () => {
  const r = await rows(`select id, public from storage.buckets order by id`);
  assert.deepEqual(
    r.map((b) => [b.id, b.public]),
    [['prints', false], ['templates', true], ['uploads', false]],
  );
});

console.log(`\n${count} checks passed against real Postgres.`);
