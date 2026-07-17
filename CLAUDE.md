# CLAUDE.md

Context for Claude Code. Read this before changing anything.

## What this is

Printify Studio: upload one photo, see it on ~11 products, buy them.
Next 15 / TypeScript / Supabase / Stripe.

Phase 1 is built and verified. The purchase path works end to end in code:
upload → mockup grid → edit → cart → Stripe → print file → provider handoff.
"Verified" means the logic is under test against real Postgres, real pixels
and real encoders — NOT that live Stripe/Supabase/Printify or a real browser
have exercised it. See "What is NOT verified" below.

## Verify before you touch anything

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 203 assertions, 15 suites
npm run test:sql    # 49 checks against real Postgres (PGlite, no server)
npm run build       # next build
npm run bench       # render timings — informational, not a gate
```

For UI changes, also drive the funnel in a real browser (17 checks,
screenshots, pixel-verified tiles):

```bash
npm run build && npm run start &
npx tsx scripts/browser-pass.mts
```

All of the above pass from a clean clone with no env vars set. If something
fails on your first run, that's a genuine problem, not setup drift.

## The three rules this codebase is built on

1. **Products are data, not code.** Nothing in `src/` knows what a keychain
   is. A product is a row in `product_templates` holding print geometry and
   an array of mockup layers; the renderer walks that array. Adding a product
   is an INSERT. If you find yourself writing `if (slug === 'phone-case')`,
   stop — the config column is where that belongs.

2. **The server recomputes every price.** The client sends design specs,
   SKUs and quantities. It never sends a price. `/api/stripe/checkout`
   re-reads everything from the DB (via `src/lib/checkout/session.ts`, which
   is pure and tested) and charges that. RLS gives clients zero write access
   to `orders` — no policy AND no grant — specifically so this can't be
   bypassed. Don't add a client-supplied amount to any payment path.

3. **One renderer.** The editor preview, the mockup grid and the print file
   all call `prepareArtwork()` in `src/lib/mockup/renderer.ts`. That is why
   the customer's approval and the printed product are the same pixels. A
   second render path would drift and you'd only find out on a manufactured
   product. The renderer touches only the 2D canvas API — that constraint is
   what lets it run in a worker and in Node. Don't reach for a DOM API inside
   it; capability comes in through `RenderEnv`.

## Where things are

```
src/lib/mockup/renderer.ts    the compositor everything shares
src/lib/mockup/spec.ts        DesignSpec zod schema + SPEC_LIMITS (one source
                              of bounds; the editor imports these)
src/lib/pricing/engine.ts     the only money implementation (client + server)
src/lib/print/                geometry, bleed, DPI gating, file generation
src/lib/checkout/             session builder, webhook machine, zipByPosition
src/lib/fulfilment/submit.ts  paid order -> print files -> provider handoff
src/lib/providers/core/       PrintProvider interface + registry with failover
src/lib/cutout/               refinement (tested) + ORMBG provider (see below)
src/stores/editor.ts          DesignSpec + undo/redo (dragBase semantics)
supabase/schema.sql           tables, RLS, triggers, storage buckets
tests/                        every suite; read one before changing its subject
```

## What is NOT verified

- **Cutout model inference** (`src/lib/cutout/ormbg.ts`) has never been run.
  Everything downstream — haze removal, islands, feathering, the quality
  gate — is tested against real pixels (22 checks). The inference call was
  written against the documented Transformers.js API in an environment that
  couldn't reach huggingface.co. Run it in a browser and expect to fix
  something. The build passes without `@huggingface/transformers` installed:
  the module name is assembled at runtime so webpack can't resolve it
  statically, and `isAvailable()` hides the feature rather than crashing.
  That's deliberate — keep it that way.
- **Live service wiring.** Stripe session creation, Supabase storage
  up/downloads, and the Printify adapter follow documented APIs; no live
  token has exercised them. Any Printify mismatch is a bug in
  `src/lib/providers/printify/adapter.ts` alone — never a reason to change
  the `PrintProvider` interface.
- **Drag frame timing.** The funnel HAS run in a real browser
  (scripts/browser-pass.mts: 17 checks in Chromium — it caught a worker
  init race and an editor stale-closure deadlock that no Node test could).
  But the pass verifies behaviour, not frame budgets: the Node/skia bench
  numbers exceed 16ms and are not representative. Measure drags on
  OffscreenCanvas in a browser before believing anything about them.
  Mobile Safari has seen nothing at all.

Everything else was verified against PGlite, real canvas pixels and the real
seed catalogue. The tests are a floor, not a guarantee.

## Landmines

- **AGPL.** Do not add `@imgly/background-removal` (AGPL-3.0; its §13 network
  clause is triggered by serving software over a network — which this is).
  BRIA's RMBG-1.4 is non-commercial-only. The Apache-2.0
  `onnx-community/ormbg-ONNX` is what's wired in. Check the licence of any
  model or vision library before adding it.
- **`instanceof` across module boundaries** silently returns false when a
  module is instantiated twice (split chunks, server/client, some test
  runners) — with a correct prototype chain and a correct `.name`. Use the
  name-check helpers: `isCutoutQualityError()`, `isPrintQualityError()`,
  `isCheckoutValidationError()`, `isNoProviderRegisteredError()`,
  `isAllProvidersFailedError()`. Never `instanceof`.
- **Identity from position, never a value lookup.** Two cart items can share
  `(templateSlug, variantSku)` and quantity — the same mug with two different
  photos. A `.find()` on those fields collapses them and the customer
  receives one photo twice. `zipByPosition()` in
  `src/lib/checkout/mapping.ts` is the only way derived checkout arrays may
  meet; `tests/checkout-mapping.test.mts` pins both the rule and the old
  logic's wrongness.
- **The DB types are hand-written and will drift.** `src/types/database.ts`
  mirrors schema.sql by hand so `tsc` is meaningful before a project exists.
  Regenerate it the moment you have one:
  `npx supabase gen types typescript --linked > src/types/database.ts`.
  If you change schema.sql, change database.ts in the same commit.

## Known gaps, in the order to fix them

1. **Real product photography.** Procedural placeholder art ships in
   public/templates/ (regenerate: scripts/generate-template-art.mts), so
   mockups composite full layer stacks — but placeholder is placeholder.
   Swapping in real photography is a bucket upload, zero code, and it is
   still the biggest lever on whether this feels premium.
2. **Regenerate the DB types from a real project** — see landmines.
3. **First LIVE-SERVICE run**: a Supabase project + Stripe test keys. The
   browser pass already exists and passes against demo mode; point it at a
   configured deployment and take checkout all the way to Stripe. Expect
   small fixes in the wiring, not the logic.
4. **Cutout model in a real browser.** See above.
5. **Live-run the auth + admin surfaces.** /admin/orders (held-order retry
   is now a click) and /login /signup /reset exist and pass the demo-mode
   browser checks, but no live Supabase session has exercised them.
   claimAnonWork() runs after every successful sign-in — verify the
   anonymous-work claim end to end with a real account.
6. **Rate limiter sharing needs Upstash creds.** The Upstash adapter exists
   behind the same RateLimiter interface (fails open on transport errors,
   documented in src/lib/rateLimit.ts) and switches on automatically when
   UPSTASH_REDIS_REST_URL/TOKEN are set; unverified against live Upstash.
   Without them, limits stay per-instance.
7. **Print generation runs inline in the webhook.** Fine for a normal basket
   (~80ms render + a few hundred ms encode per item). A 50-item order won't
   fit — that's the trigger for a queue, not a reason to build one now.

## Conventions

- **Money is integer minor units.** Never floats. Never a `number` that might
  be dollars. The DB enforces `total = subtotal - discount_total + tax +
  shipping` as a CHECK.
- **Comments explain why**, especially where the obvious approach is wrong.
  Several comments in here are the only record of a bug class that costs real
  money (the seam-pad geometry, the flood-fill stack, the positional
  identity rule) — don't tidy them away.
- **Tests assert on real pixels / real Postgres, not mocks.** If a test can't
  distinguish the states it asserts on, it proves nothing when it passes and
  lies when it fails. Place probes where the states actually differ (see the
  probe comments in `tests/mockup.test.mts`).
- **User-facing errors say what to do next**, not what went wrong internally.
- **Failure states are deliberate.** `unsubmitted` = no provider configured
  (correct, recoverable). `error` + `provider_response.stage` = held on
  purpose with money intact. Don't "fix" a hold by weakening the gate.
