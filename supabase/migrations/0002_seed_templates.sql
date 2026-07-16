-- Seed catalogue: 11 products, 17 variants, 7 collections, 5 bundles — all as
-- pure data. Nothing in src/ knows any of these names.
--
-- Geometry here is a starting guess. Every ARTWORK rect and mesh will want
-- adjusting against real product photography (see Setup: "Making mockups look
-- like anything"). The image paths reference the public `templates` storage
-- bucket; until art is uploaded there, mockups render grey — engine working,
-- art absent.

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('phone-case', 'Phone Case', 'Slim polycarbonate case with an edge-to-edge print.',
 '{"print":{"widthIn":3.0,"heightIn":6.0,"bleedIn":0.125,"safeIn":0.125,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"phone-case/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.32,"y":0.12,"w":0.36,"h":0.76}},
   {"type":"MASK","src":"phone-case/mask.png"},
   {"type":"IMAGE","src":"phone-case/camera.png"},
   {"type":"OVERLAY","src":"phone-case/gloss.png","blend":"multiply"}
 ]'::jsonb,
 array['phone','tech','case'], 10);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('mug', 'Mug', 'Ceramic mug, dishwasher safe, wrap-around print.',
 '{"print":{"widthIn":8.5,"heightIn":3.5,"bleedIn":0.125,"safeIn":0.125,"minDpi":100},"requiresCutout":false}'::jsonb,
 -- The mesh is the one thing per product that needs real calibration work
 -- rather than a guess. This 4x2 grid is a placeholder shape; a convincing
 -- cylindrical wrap needs a denser mesh calibrated against the actual photo.
 '[
   {"type":"IMAGE","src":"mug/bg.jpg"},
   {"type":"MESH_WARP","rect":{"x":0.28,"y":0.30,"w":0.44,"h":0.45},
    "mesh":{"cols":4,"rows":2,"points":[
      [0.28,0.32],[0.39,0.30],[0.50,0.295],[0.61,0.30],[0.72,0.32],
      [0.28,0.53],[0.39,0.525],[0.50,0.52],[0.61,0.525],[0.72,0.53],
      [0.28,0.72],[0.39,0.745],[0.50,0.75],[0.61,0.745],[0.72,0.72]
    ]}},
   {"type":"SHADOW","src":"mug/shadow.png"},
   {"type":"OVERLAY","src":"mug/gloss.png","blend":"multiply"}
 ]'::jsonb,
 array['mug','kitchen','coffee'], 20);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('tshirt', 'T-Shirt', 'Heavyweight cotton tee, front print.',
 '{"print":{"widthIn":12.0,"heightIn":16.0,"bleedIn":0.0,"safeIn":0.5,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"tshirt/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.34,"y":0.24,"w":0.32,"h":0.42}},
   {"type":"OVERLAY","src":"tshirt/fabric.png","blend":"multiply"}
 ]'::jsonb,
 array['apparel','tshirt','clothing'], 30);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('tote-bag', 'Tote Bag', 'Natural canvas tote, single-side print.',
 '{"print":{"widthIn":14.0,"heightIn":14.0,"bleedIn":0.0,"safeIn":0.5,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"tote-bag/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.30,"y":0.34,"w":0.40,"h":0.40}},
   {"type":"OVERLAY","src":"tote-bag/weave.png","blend":"multiply"}
 ]'::jsonb,
 array['bag','tote','apparel'], 40);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('poster', 'Poster', 'Matte poster on 200gsm stock.',
 '{"print":{"widthIn":12.0,"heightIn":18.0,"bleedIn":0.125,"safeIn":0.25,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"poster/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.30,"y":0.14,"w":0.40,"h":0.72}},
   {"type":"OVERLAY","src":"poster/light.png","blend":"multiply"}
 ]'::jsonb,
 array['wall-art','poster','print'], 50);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('canvas-print', 'Canvas Print', 'Gallery-wrapped canvas, 1.25in bars.',
 '{"print":{"widthIn":16.0,"heightIn":20.0,"bleedIn":1.25,"safeIn":0.5,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"canvas-print/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.28,"y":0.16,"w":0.44,"h":0.66}},
   {"type":"OVERLAY","src":"canvas-print/texture.png","blend":"multiply"}
 ]'::jsonb,
 array['wall-art','canvas','print'], 60);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('keychain', 'Acrylic Keychain', 'Die-cut acrylic keychain of your subject.',
 '{"print":{"widthIn":2.0,"heightIn":2.0,"bleedIn":0.0625,"safeIn":0.0625,"minDpi":100},"requiresCutout":true}'::jsonb,
 '[
   {"type":"IMAGE","src":"keychain/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.38,"y":0.34,"w":0.24,"h":0.24}},
   {"type":"MASK","src":"keychain/mask.png"},
   {"type":"SHADOW","src":"keychain/shadow.png"},
   {"type":"OVERLAY","src":"keychain/gloss.png","blend":"screen"}
 ]'::jsonb,
 array['keychain','gift','die-cut'], 70);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('sticker-sheet', 'Sticker Sheet', 'Kiss-cut vinyl sticker sheet.',
 '{"print":{"widthIn":5.5,"heightIn":8.5,"bleedIn":0.0625,"safeIn":0.125,"minDpi":100},"requiresCutout":true}'::jsonb,
 '[
   {"type":"IMAGE","src":"sticker-sheet/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.30,"y":0.16,"w":0.40,"h":0.62}},
   {"type":"MASK","src":"sticker-sheet/mask.png"},
   {"type":"OVERLAY","src":"sticker-sheet/sheen.png","blend":"screen"}
 ]'::jsonb,
 array['sticker','die-cut','gift'], 80);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('photo-stamps', 'Photo Stamps', 'A sheet of 16 photo stamps.',
 '{"print":{"widthIn":8.0,"heightIn":10.0,"bleedIn":0.125,"safeIn":0.125,"minDpi":100},"requiresCutout":false}'::jsonb,
 -- 16 ARTWORK cells of the same artwork. The renderer memoizes the prepared
 -- artwork per render — re-preparing per cell once cost a 666ms editor frame.
 '[
   {"type":"IMAGE","src":"photo-stamps/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.06,"y":0.06,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.29,"y":0.06,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.52,"y":0.06,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.75,"y":0.06,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.06,"y":0.29,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.29,"y":0.29,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.52,"y":0.29,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.75,"y":0.29,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.06,"y":0.52,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.29,"y":0.52,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.52,"y":0.52,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.75,"y":0.52,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.06,"y":0.75,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.29,"y":0.75,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.52,"y":0.75,"w":0.20,"h":0.20}},
   {"type":"ARTWORK","rect":{"x":0.75,"y":0.75,"w":0.20,"h":0.20}},
   {"type":"OVERLAY","src":"photo-stamps/perforation.png","blend":"multiply"}
 ]'::jsonb,
 array['stamps','gift','photo'], 90);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('mousepad', 'Mousepad', 'Smooth-surface mousepad with stitched edge.',
 '{"print":{"widthIn":9.25,"heightIn":7.75,"bleedIn":0.125,"safeIn":0.25,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"mousepad/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.26,"y":0.30,"w":0.48,"h":0.40}},
   {"type":"OVERLAY","src":"mousepad/light.png","blend":"multiply"}
 ]'::jsonb,
 array['desk','office','mousepad'], 100);

insert into public.product_templates (slug, name, description, config, mockup_layers, ai_tags, sort_order) values
('coaster', 'Coaster Set', 'Set of two cork-backed coasters.',
 '{"print":{"widthIn":4.0,"heightIn":4.0,"bleedIn":0.0625,"safeIn":0.125,"minDpi":100},"requiresCutout":false}'::jsonb,
 '[
   {"type":"IMAGE","src":"coaster/bg.jpg"},
   {"type":"ARTWORK","rect":{"x":0.36,"y":0.36,"w":0.28,"h":0.28}},
   {"type":"MASK","src":"coaster/mask.png"},
   {"type":"OVERLAY","src":"coaster/light.png","blend":"multiply"}
 ]'::jsonb,
 array['desk','kitchen','coaster'], 110);

-- ---------------------------------------------------------------------------
-- Variants (17). Retail prices in integer cents.
-- ---------------------------------------------------------------------------

insert into public.product_variants (template_id, sku, name, price)
select id, 'PHN-IP15', 'iPhone 15', 2499 from public.product_templates where slug = 'phone-case';
insert into public.product_variants (template_id, sku, name, price)
select id, 'PHN-IP15P', 'iPhone 15 Pro', 2499 from public.product_templates where slug = 'phone-case';

insert into public.product_variants (template_id, sku, name, price)
select id, 'MUG-11-WHT', '11 oz — White', 1499 from public.product_templates where slug = 'mug';
insert into public.product_variants (template_id, sku, name, price)
select id, 'MUG-15-WHT', '15 oz — White', 1799 from public.product_templates where slug = 'mug';

insert into public.product_variants (template_id, sku, name, price)
select id, 'TEE-BLK-S', 'Black — S', 2199 from public.product_templates where slug = 'tshirt';
insert into public.product_variants (template_id, sku, name, price)
select id, 'TEE-BLK-M', 'Black — M', 2199 from public.product_templates where slug = 'tshirt';
insert into public.product_variants (template_id, sku, name, price)
select id, 'TEE-BLK-L', 'Black — L', 2199 from public.product_templates where slug = 'tshirt';

insert into public.product_variants (template_id, sku, name, price)
select id, 'TOTE-STD', 'Natural canvas', 1899 from public.product_templates where slug = 'tote-bag';

-- Poster/canvas sizes share a template; the print size difference lives in the
-- variant config override.
insert into public.product_variants (template_id, sku, name, price, config)
select id, 'PSTR-12x18', '12 x 18 in', 1299, '{"print":{"widthIn":12.0,"heightIn":18.0}}'::jsonb
from public.product_templates where slug = 'poster';
insert into public.product_variants (template_id, sku, name, price, config)
select id, 'PSTR-18x24', '18 x 24 in', 1999, '{"print":{"widthIn":18.0,"heightIn":24.0}}'::jsonb
from public.product_templates where slug = 'poster';

insert into public.product_variants (template_id, sku, name, price, config)
select id, 'CNVS-12x12', '12 x 12 in', 3999, '{"print":{"widthIn":12.0,"heightIn":12.0}}'::jsonb
from public.product_templates where slug = 'canvas-print';
insert into public.product_variants (template_id, sku, name, price, config)
select id, 'CNVS-16x20', '16 x 20 in', 5999, '{"print":{"widthIn":16.0,"heightIn":20.0}}'::jsonb
from public.product_templates where slug = 'canvas-print';

insert into public.product_variants (template_id, sku, name, price)
select id, 'KEY-ACR', 'Acrylic', 999 from public.product_templates where slug = 'keychain';

insert into public.product_variants (template_id, sku, name, price)
select id, 'STK-SHEET', '5.5 x 8.5 in sheet', 799 from public.product_templates where slug = 'sticker-sheet';

insert into public.product_variants (template_id, sku, name, price)
select id, 'STMP-16', 'Sheet of 16', 1599 from public.product_templates where slug = 'photo-stamps';

insert into public.product_variants (template_id, sku, name, price)
select id, 'PAD-STD', '9.25 x 7.75 in', 1499 from public.product_templates where slug = 'mousepad';

insert into public.product_variants (template_id, sku, name, price)
select id, 'CSTR-2PK', 'Set of 2', 1299 from public.product_templates where slug = 'coaster';

-- ---------------------------------------------------------------------------
-- Collections (7)
-- ---------------------------------------------------------------------------

insert into public.collections (slug, name, sort_order) values
  ('best-sellers',      'Best Sellers',       10),
  ('wall-art',          'Wall Art',           20),
  ('apparel',           'Apparel & Bags',     30),
  ('home-office',       'Home & Office',      40),
  ('gifts-under-20',    'Gifts Under $20',    50),
  ('for-your-desk',     'For Your Desk',      60),
  ('stocking-stuffers', 'Stocking Stuffers',  70);

insert into public.collection_items (collection_id, template_id, sort_order)
select c.id, t.id, x.sort_order
from (values
  ('best-sellers', 'mug', 10),
  ('best-sellers', 'tshirt', 20),
  ('best-sellers', 'canvas-print', 30),
  ('wall-art', 'poster', 10),
  ('wall-art', 'canvas-print', 20),
  ('apparel', 'tshirt', 10),
  ('apparel', 'tote-bag', 20),
  ('home-office', 'mug', 10),
  ('home-office', 'mousepad', 20),
  ('home-office', 'coaster', 30),
  ('gifts-under-20', 'keychain', 10),
  ('gifts-under-20', 'sticker-sheet', 20),
  ('gifts-under-20', 'photo-stamps', 30),
  ('gifts-under-20', 'mug', 40),
  ('for-your-desk', 'mousepad', 10),
  ('for-your-desk', 'coaster', 20),
  ('for-your-desk', 'photo-stamps', 30),
  ('stocking-stuffers', 'keychain', 10),
  ('stocking-stuffers', 'sticker-sheet', 20),
  ('stocking-stuffers', 'photo-stamps', 30)
) as x(collection_slug, template_slug, sort_order)
join public.collections c on c.slug = x.collection_slug
join public.product_templates t on t.slug = x.template_slug;

-- ---------------------------------------------------------------------------
-- Bundles (5). reward matches BundleReward in src/lib/pricing/types.ts.
--
-- NOTE the explicit ::jsonb on EVERY branch: jsonb literals in a UNION inherit
-- `text` from the first branch unless each is cast. Uncast, this statement
-- parses fine and then fails on `supabase db push` — a bug caught by running
-- the seed against real Postgres, which is why test:sql exists.
-- ---------------------------------------------------------------------------

insert into public.bundles (id, name, skus, quantity, reward, priority, active)
select 'wall-art-trio', 'Wall Art Trio',
       array['PSTR-12x18','PSTR-18x24','CNVS-12x12','CNVS-16x20'], 3,
       '{"kind":"percent","value":20}'::jsonb, 60, true
union all
select 'tee-three', 'Three Tees',
       array['TEE-BLK-S','TEE-BLK-M','TEE-BLK-L'], 3,
       '{"kind":"percent","value":25}'::jsonb, 55, true
union all
select 'mug-pair', 'Mug Pair',
       array['MUG-11-WHT','MUG-15-WHT'], 2,
       '{"kind":"percent","value":15}'::jsonb, 50, true
union all
select 'sticker-stack', 'Sticker Stack',
       array['STK-SHEET'], 3,
       '{"kind":"fixed","value":400}'::jsonb, 40, true
union all
select 'desk-set', 'Desk Set',
       array['PAD-STD','CSTR-2PK','MUG-11-WHT'], 3,
       '{"kind":"percent","value":10}'::jsonb, 30, true;

-- ---------------------------------------------------------------------------
-- A starter discount code. Validated only through /api/discount/validate —
-- clients cannot read this table.
-- ---------------------------------------------------------------------------

insert into public.discounts (code, kind, value, active) values
  ('WELCOME10', 'percent', 10, true);
