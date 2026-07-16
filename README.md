# Printify Studio

Upload one photo. See it on every product.

Phase 1 foundation: schema, pricing engine, mockup engine, editor, provider
abstraction, checkout path, print pipeline, and the studio UI. Verified by
running, not by inspection — see **Status** for exactly what exists, what
doesn't, and what has never been run.

## Quick start

```bash
npm install
cp .env.example .env.local          # fill in Supabase + Stripe keys

# Database
npx supabase link --project-ref <ref>
npx supabase db push                # applies supabase/schema.sql + migrations
npx supabase gen types typescript --linked > src/types/database.ts

npm run typecheck && npm test       # 203 assertions, 15 suites
npm run test:sql                    # 49 checks against real Postgres (PGlite)
npm run dev
```

Stripe webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# paste the printed whsec_... into STRIPE_WEBHOOK_SECRET
```

Everything above except the Supabase steps passes from a clean clone with **no
environment variables set**. If it doesn't, that's a real problem — don't work
around it.

## The three decisions everything else follows from

### 1. Products are data, not code

`src/` contains no file that knows what a keychain is. A product is a row in
`product_templates` holding its print geometry and an ordered array of mockup
layers; the renderer walks that array. Adding "Air Freshener" is an `INSERT`
(see `supabase/migrations/0002_seed_templates.sql` — 11 products, 17 variants,
7 collections, 5 bundles, all as data).

### 2. Prices are recomputed server-side, always

The client posts design specs, SKUs and quantities. It never posts a price —
the payload type doesn't have the field, and a test smuggles one in anyway to
prove it changes nothing. `/api/stripe/checkout` re-reads every price from the
database, recomputes bundles and discounts through the same
`src/lib/pricing/engine.ts` the cart used for display, and charges exactly
that. RLS gives clients zero write access to `orders` (no policy AND no grant)
so this can't be bypassed, and a database CHECK makes an order whose parts
disagree with its total unrecordable.

### 3. One renderer

The editor preview, the mockup grid, and the print file all call
`prepareArtwork()` in `src/lib/mockup/renderer.ts`. That is why the customer's
approval and the printed product are the same pixels — pinned by a test that
samples a print-scale render against a 400px preview at proportional points.
The renderer touches only the 2D canvas API (capability injected via
`RenderEnv`), which is what lets the same code run in a browser worker and in
Node inside the webhook.

## Layout

```
src/
  app/
    upload → studio → customize/[slug] → cart → orders/confirmed
    api/
      stripe/checkout      ← recomputes all money, creates the order
      stripe/webhook       ← idempotent; confirms payment, runs fulfilment
      designs/persist      ← local cart items → design rows (positional ids)
      admin/orders/[id]/retry  ← the way out for a held order
      catalogue, bundles   ← public data through RLS
      discount/validate    ← rate-limited; never an enumeration oracle
      upload/sign          ← signed upload URLs; anonymous uploads allowed
      cutout               ← deliberate 501; cutouts run in the browser
  lib/
    mockup/     types + renderer + warp math + spec schema + browser env
    pricing/    engine.ts (the only money implementation) + shipping.ts
    print/      geometry, bleed, DPI gating, print file generation
    checkout/   session builder, webhook state machine, positional mapping
    fulfilment/ orchestration (submit.ts) + retry rules + Supabase wiring
    providers/  core contract + registry with failover + printify adapter
    cutout/     refinement pipeline (tested) + ORMBG provider (unverified)
    supabase/   client (browser) / route (RLS) / service (bypasses RLS)
  stores/       zustand vanilla: editor (undo/redo), cart, artwork
  workers/      mockup.worker.ts — the grid's streaming renderer
supabase/
  schema.sql                    tables, RLS, triggers, storage buckets
  migrations/0002_seed_templates.sql   the catalogue as pure data
tests/                          every suite; read one before changing its subject
```

## Verification

252 checks across 17 suites, all run against real Postgres (PGlite,
in-process), real pixels (@napi-rs/canvas), and real encoders — not mocks —
plus a 17-check Playwright pass that drives the built app in Chromium
(scripts/browser-pass.mts): worker-rendered tiles pixel-verified, editor
drag/undo through the real store, and the cart's bundle math checked to the
cent through the real UI:

- **Pricing (30)** — bundle greediness, overlapping bundles sharing one stock
  pool, discount-after-bundle ordering, tax on the post-discount amount only,
  half-up rounding, integer-only outputs, discounts never exceeding subtotal.
- **Renderer (20)** — layer order, resolution independence, transforms with
  probes that distinguish states, pixel-exact filters, mask/blend semantics,
  mesh identity + mirror, seam regression on a cylinder-like sliver mesh, and
  2,000 random triangles mapping affine to <1e-6.
- **Editor (29)** — clamps (zoom < 1 prints blank edges), patch purity, and
  the data-loss cases: deep-copied history, undo after a 200-frame drag,
  redo-branch invalidation.
- **Print (23)** — bleed math, safe zones relative to trim (not the bled
  canvas), per-product DPI gating against the real catalogue, bleed coverage
  at all four corners, spec fidelity at print scale, a 24MP-budget render.
- **Checkout (37)** — server recompute untouchable by client numbers, the
  duplicate-SKU positional seam (including a test asserting the OLD logic was
  wrong), webhook idempotency: a replayed Stripe delivery is provably a no-op.
- **Fulfilment (25)** — held orders with the failing stage recorded, retry
  guards judged on real DB rows, format-by-config (PNG only for die-cut),
  provider failover, print bytes verified by JPEG/PNG magic numbers.
- **Cutout (22)** — haze removal, speckle islands, edge feathering, bbox, the
  quality gate, and a 1.44M-pixel flood fill that must not blow the stack
  (~83ms).
- **SQL (49)** — schema + seed applied to real Postgres, live RLS enforcement
  under the actual client roles, cross-user isolation, storage bucket privacy.

`npm run bench` renders the full 11-product grid through the real seed
catalogue in ~570ms (~18x headroom under the 10-second promise). The
drag-frame numbers from Node/skia exceed the 16ms browser budget and are NOT
representative — the editor drags on OffscreenCanvas in a browser, which is
where that budget must be measured. Treat drag performance as unverified.

## Print files — how an order actually ships

The Stripe webhook confirms payment (idempotently), then runs
`fulfilOrder()`: render each item at print scale through `prepareArtwork()`,
encode (JPEG q95 for photo products; PNG only where `config.requiresCutout`
needs alpha — PNG at photo sizes costs ~8s/28MB and doesn't belong in a
webhook), store to the private `prints` bucket, and hand signed URLs to a
provider via the registry.

**Bad art holds the order.** Below the 100 DPI floor, `assertPrintable()`
throws and the order lands at `fulfilment_status = 'error'` with the reason
recorded — `status` stays `paid`, so no money is lost, and no provider ever
hears about the order. Holding after payment sounds backwards; the
alternative is manufacturing something unacceptable and eating the refund
plus shipping plus goodwill. A held order is recoverable. A printed blurry
canvas is not. `POST /api/admin/orders/[id]/retry` is the way out, and it
refuses unpaid orders (would ship for free) and accepted ones (would ship
twice).

**No provider configured** is not an error: paid orders sit at
`fulfilment_status = 'unsubmitted'` until a token is set — visible,
recoverable, correct.

## A licensing landmine — read before touching cutouts

Do **not** add `@imgly/background-removal`. It's AGPL-3.0, and §13's network
clause is triggered by serving software over a network — which is what this
is. It would arguably oblige you to open-source this codebase; img.ly sell a
commercial licence for precisely this reason. BRIA's RMBG-1.4 is
non-commercial-only — also out. What's wired in is `onnx-community/ormbg-ONNX`
(Apache-2.0) via Transformers.js. Check the licence of any model or vision
library before adding it — the popular ones are one line to use and warn you
about nothing. The whole decision sits behind `CutoutProvider`
(`src/lib/cutout/types.ts`): swapping to a paid API is a new class, not a
refactor.

## Deploying to Vercel

1. Push to GitHub, import in Vercel.
2. Add every var from `.env.example`. `SUPABASE_SERVICE_ROLE_KEY` must not be
   `NEXT_PUBLIC_*`.
3. Set `NEXT_PUBLIC_SITE_URL` to the production domain.
4. Stripe → Webhooks → add `https://<domain>/api/stripe/webhook`, events:
   `checkout.session.completed`, `checkout.session.expired`,
   `charge.refunded`. Copy that endpoint's signing secret — it's not the
   local one, and using the wrong one fails silently.
5. Supabase → Auth → URL Configuration → add the domain.
6. Promote your admin user:
   `update public.users set role = 'admin' where email = '...';`

`@napi-rs/canvas` is a native module; `next.config.ts` already externalises
it (`serverExternalPackages`) — without that the build fails trying to parse
a `.node` binary as JavaScript. The webhook route pins `runtime = 'nodejs'`
because signature verification needs the raw body.

## Status

**Working and tested** — schema/RLS/buckets/triggers; the 11-product seed;
mockup engine incl. mesh warp, streaming per product from a worker; pricing;
server-authoritative checkout + idempotent webhook; fulfilment with held-order
recovery; Printify adapter + registry failover; upload → grid → editor → cart
→ confirmation, the full purchase loop; cutout refinement + quality gate.

**Wired but never run against live services** — the Stripe session creation,
Supabase storage calls, and the Printify adapter are written against
documented APIs with their logic under test, but no live token has ever been
exercised. First contact will surface something. Any Printify mismatch is a
bug in `src/lib/providers/printify/adapter.ts` alone — never a reason to
change the `PrintProvider` interface.

**Partially verified in a real browser** — the funnel (upload → grid →
editor → cart) passes a 17-check Chromium pass in zero-env demo mode; live
Stripe/Supabase and mobile browsers have seen nothing. Cutout model
inference (`src/lib/cutout/ormbg.ts`) has NEVER been run: it was written where
huggingface.co is unreachable. `npm install @huggingface/transformers`, run
it, and expect to fix something. Before launch, self-host the weights
(`NEXT_PUBLIC_MODEL_BASE_URL`) — the default puts a third-party CDN in the
critical path of every customer's first cutout.

**Scaffolded, not built** — admin dashboard UI (the retry endpoint exists and
is guarded; nothing calls it but curl), auth pages (Supabase handles the
mechanics), marketing pages (the landing is a placeholder), server-side
cutout (`/api/cutout` is a deliberate 501), Printful/Gelato/CustomCat
adapters. The DB types (`src/types/database.ts`) are hand-written against
schema.sql and will drift — regenerate with `supabase gen types` the moment
a project exists.

**Deliberately not attempted** — AR preview (a project, not a file); AI
tagging/upscaling/generation (the schema carries `analysis` and `ai_tags` so
they're a tag query the day a model is wired in); creator marketplace,
referrals, loyalty (`users` carries the columns so identity never needs
backfilling); order splitting across providers (an order needing two
providers is held with an explanation — guessing per-shipment state before a
real provider is connected is how you get a migration you regret).

The single biggest lever on whether this feels premium is **real product
photography**. Procedural placeholder art ships in `public/templates/`
(regenerate with `scripts/generate-template-art.mts`) so every mockup
composites a full layer stack today; swapping in real photography, masks and
lighting is a `templates`-bucket upload — zero code.
