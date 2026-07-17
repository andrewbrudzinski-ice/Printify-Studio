-- Printify Studio — tables, RLS, triggers, storage buckets.
--
-- Applied to a real project by `supabase db push`; applied to real Postgres
-- in-process (PGlite) by `npm run test:sql`, which stubs the auth/storage
-- schemas Supabase normally provides.
--
-- The rules this schema enforces (see CLAUDE.md):
--   * Products are data. product_templates.config + mockup_layers describe
--     everything the renderer and print pipeline need. Adding a product is an
--     INSERT here, never a code change.
--   * Clients have ZERO write access to orders. Every order row is written by
--     the server (service-role key) after recomputing prices from this
--     database. There is deliberately no INSERT/UPDATE/DELETE policy — and no
--     grant — on orders or order_items for client roles. Don't add one.
--   * discounts and provider_mappings have NO client policies at all.
--     Discount codes must not be enumerable ("does this code exist?" must go
--     through the rate-limited /api/discount/validate), and provider_mappings
--     carries wholesale cost, which is never shown to a client.

-- ---------------------------------------------------------------------------
-- users — application profile over auth.users, created by trigger.
-- referral_code / referred_by / store_credit / loyalty_points exist now so
-- identity data never needs backfilling when those features arrive. Nothing
-- reads them yet.
-- ---------------------------------------------------------------------------
create table public.users (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  role            text not null default 'customer' check (role in ('customer', 'admin')),
  referral_code   text unique,
  referred_by     uuid references public.users (id),
  store_credit    integer not null default 0 check (store_credit >= 0),
  loyalty_points  integer not null default 0 check (loyalty_points >= 0),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Catalogue. A product is a row: print geometry + an ordered array of mockup
-- layers. Nothing in src/ knows what a keychain is.
-- ---------------------------------------------------------------------------
create table public.product_templates (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  description   text not null default '',
  -- {"print":{"widthIn","heightIn","bleedIn","safeIn","minDpi"},"requiresCutout":bool}
  -- requiresCutout also decides the print file format downstream: die-cut
  -- products need alpha (PNG); everything else ships JPEG.
  config        jsonb not null,
  -- Ordered layer stack. All geometry normalised 0..1 so one template renders
  -- identically at 400px and 2000px.
  mockup_layers jsonb not null default '[]'::jsonb,
  ai_tags       text[] not null default '{}',
  active        boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

create table public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.product_templates (id) on delete cascade,
  sku         text not null unique,
  name        text not null,
  -- Retail price in integer cents. Wholesale cost lives in provider_mappings,
  -- which clients cannot read.
  price       integer not null check (price >= 0),
  -- Optional per-variant overrides (e.g. poster sizes share a template but
  -- differ in print dimensions).
  config      jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  sort_order  integer not null default 0
);

create table public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  template_id   uuid not null references public.product_templates (id) on delete cascade,
  sort_order    integer not null default 0,
  primary key (collection_id, template_id)
);

-- Bundle rules consumed by the pricing engine (src/lib/pricing). The reward
-- jsonb matches BundleReward: {"kind":"percent"|"fixed","value":n}.
create table public.bundles (
  id       text primary key,
  name     text not null,
  skus     text[] not null,
  quantity integer not null check (quantity > 0),
  reward   jsonb not null,
  priority integer not null default 0,
  active   boolean not null default true
);

-- No client policies on purpose — see header.
create table public.discounts (
  code            text primary key,
  kind            text not null check (kind in ('percent', 'fixed')),
  value           integer not null check (value >= 0),
  active          boolean not null default true,
  expires_at      timestamptz,
  max_redemptions integer,
  redemptions     integer not null default 0 check (redemptions >= 0)
);

-- ---------------------------------------------------------------------------
-- Customer work. Anonymous uploads are allowed on purpose — demanding a signup
-- before anyone has seen a mockup kills the funnel. Anonymous projects carry
-- an anon_token and a null user_id; claim_anon_projects() attaches them to the
-- account at signup.
-- ---------------------------------------------------------------------------
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.users (id) on delete cascade,
  anon_token text,
  created_at timestamptz not null default now(),
  -- A project is owned or anonymous, never neither.
  check (user_id is not null or anon_token is not null)
);

create index projects_anon_token_idx on public.projects (anon_token)
  where anon_token is not null;

create table public.project_images (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  storage_path  text not null,
  width         integer not null check (width > 0),
  height        integer not null check (height > 0),
  -- Ready for AI features that aren't wired in yet; a model integration
  -- becomes a tag query, not a migration.
  analysis      jsonb,
  ai_tags       text[] not null default '{}',
  cutout_status text not null default 'none'
                  check (cutout_status in ('none', 'pending', 'done', 'error')),
  cutout_path   text,
  created_at    timestamptz not null default now()
);

create index project_images_project_idx on public.project_images (project_id);

-- A design is one image placed on one product: the DesignSpec the editor
-- writes and the renderer reads. The spec is the single source of truth for
-- what gets printed.
create table public.designs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  image_id    uuid not null references public.project_images (id) on delete cascade,
  template_id uuid not null references public.product_templates (id),
  spec        jsonb not null,
  created_at  timestamptz not null default now()
);

create index designs_user_idx on public.designs (user_id);

-- ---------------------------------------------------------------------------
-- Orders. Written exclusively by the server after recomputing every price.
-- status tracks money; fulfilment_status tracks manufacturing. They are
-- separate on purpose: a paid order held at fulfilment_status='error' has
-- lost no money and is recoverable. 'unsubmitted' after payment means no
-- provider is registered — the correct failure mode, not a bug.
-- ---------------------------------------------------------------------------
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references public.users (id),
  email              text not null,
  status             text not null default 'pending'
                       check (status in ('pending', 'paid', 'refunded', 'expired')),
  fulfilment_status  text not null default 'unsubmitted'
                       check (fulfilment_status in ('unsubmitted', 'submitting', 'accepted', 'error')),
  stripe_session_id  text unique,
  -- Money: integer cents, and the identity is enforced by the database so a
  -- server bug cannot record an order whose parts disagree with its total.
  subtotal           integer not null check (subtotal >= 0),
  discount_total     integer not null default 0 check (discount_total >= 0),
  tax                integer not null default 0 check (tax >= 0),
  shipping           integer not null default 0 check (shipping >= 0),
  total              integer not null check (total >= 0),
  check (total = subtotal - discount_total + tax + shipping),
  currency           text not null default 'usd',
  shipping_address   jsonb,
  -- Which stage of provider handoff failed and why — the admin retry reads this.
  provider_response  jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index orders_user_idx on public.orders (user_id);

create table public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders (id) on delete cascade,
  -- Two rows may share (order_id, variant_id) with different designs — the
  -- same mug with two different photos. No unique constraint here, ever.
  -- Identity comes from this row's id, not from a value lookup.
  design_id      uuid not null references public.designs (id),
  variant_id     uuid not null references public.product_variants (id) on delete restrict,
  quantity       integer not null check (quantity > 0),
  unit_price     integer not null check (unit_price >= 0),
  print_file_url text,
  created_at     timestamptz not null default now()
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Provider mappings: variant SKU -> provider's product/variant IDs + wholesale
-- cost. The registry picks by priority and fails over. Application code never
-- sees a provider-specific ID.
-- ---------------------------------------------------------------------------
create table public.provider_mappings (
  id                  uuid primary key default gen_random_uuid(),
  variant_id          uuid not null references public.product_variants (id) on delete cascade,
  provider            text not null,
  provider_product_id text not null,
  provider_variant_id text not null,
  -- Wholesale, integer cents. Never exposed to clients.
  cost                integer not null check (cost >= 0),
  priority            integer not null default 100,
  unique (variant_id, provider)
);

-- ---------------------------------------------------------------------------
-- Functions & triggers
-- ---------------------------------------------------------------------------

-- security definer so it can read users regardless of the caller's row access;
-- also avoids recursive RLS when a users policy wants to ask "am I an admin?".
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role = 'admin' from public.users where id = auth.uid()),
    false
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Claim anonymous work at signup. security definer because the anon rows have
-- user_id null — the caller can't see them under RLS, but may claim them by
-- proving possession of the token.
create or replace function public.claim_anon_projects(p_token text)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in before claiming projects.';
  end if;
  update public.projects
     set user_id = auth.uid(),
         anon_token = null
   where anon_token = p_token
     and user_id is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security. Every public table has RLS enabled; a table with no
-- policy for a role is invisible/immutable to that role.
-- ---------------------------------------------------------------------------
alter table public.users             enable row level security;
alter table public.product_templates enable row level security;
alter table public.product_variants  enable row level security;
alter table public.collections       enable row level security;
alter table public.collection_items  enable row level security;
alter table public.bundles           enable row level security;
alter table public.discounts         enable row level security;
alter table public.projects          enable row level security;
alter table public.project_images    enable row level security;
alter table public.designs           enable row level security;
alter table public.orders            enable row level security;
alter table public.order_items       enable row level security;
alter table public.provider_mappings enable row level security;

-- Own profile only.
create policy users_select_own on public.users
  for select to authenticated
  using (id = auth.uid());

-- Catalogue: anyone may read what's active. Writes happen only through the
-- service role (admin API), which bypasses RLS — so no write policies exist.
create policy templates_public_read on public.product_templates
  for select to anon, authenticated
  using (active);

create policy variants_public_read on public.product_variants
  for select to anon, authenticated
  using (active);

create policy collections_public_read on public.collections
  for select to anon, authenticated
  using (true);

create policy collection_items_public_read on public.collection_items
  for select to anon, authenticated
  using (true);

create policy bundles_public_read on public.bundles
  for select to anon, authenticated
  using (active);

-- discounts, provider_mappings: no policies. See header.

-- Projects and their children: owner only. Anonymous rows (user_id null) are
-- reachable only through the service role and claim_anon_projects().
create policy projects_owner_all on public.projects
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy project_images_owner_all on public.project_images
  for all to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.user_id = auth.uid()
  ));

create policy designs_owner_all on public.designs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Orders: read your own. No write policy — see header.
create policy orders_select_own on public.orders
  for select to authenticated
  using (user_id = auth.uid());

create policy order_items_select_own on public.order_items
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id and o.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- Grants. RLS restricts rows; grants restrict verbs. Both are deliberate:
-- even a future policy mistake on orders can't grant writes the role never had.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on public.product_templates, public.product_variants,
                public.collections, public.collection_items, public.bundles
  to anon, authenticated;

grant select on public.users, public.orders, public.order_items
  to authenticated;

grant select, insert, update, delete
  on public.projects, public.project_images, public.designs
  to authenticated;

grant execute on function public.claim_anon_projects(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Storage buckets. templates is public (mockup art is not a secret); uploads
-- and prints are private — print files are signed to the provider, never
-- publicly readable.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('uploads',   'uploads',   false),
  ('templates', 'templates', true),
  ('prints',    'prints',    false)
on conflict (id) do nothing;
