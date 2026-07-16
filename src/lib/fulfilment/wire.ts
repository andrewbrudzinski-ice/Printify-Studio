// Node-side wiring of FulfilmentDeps: Supabase storage/tables + @napi-rs/canvas
// + the provider registry. Used by the Stripe webhook and the admin retry
// route. This file is I/O glue over the tested orchestration in submit.ts —
// UNVERIFIED against live Supabase storage, same convention as the routes.

import 'server-only';
import { supabaseService } from '../supabase/service';
import { registry } from '../providers/core/registry';
import { registerConfiguredProviders } from '../providers/register';
import type { FulfilmentDeps, FulfilmentOrder, MappingRow, PrintFormat } from './submit';
import type { RenderCanvas, SourceImage } from '../mockup/types';

let providersRegistered = false;

export function makeFulfilmentDeps(): FulfilmentDeps {
  if (!providersRegistered) {
    registerConfiguredProviders(registry);
    providersRegistered = true;
  }
  const db = supabaseService();

  return {
    env: {
      createCanvas(w, h) {
        // Lazy so the module can be imported (and the app built) without the
        // native package resolved; it's an optional path until an order lands.
        const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
        return createCanvas(w, h) as unknown as RenderCanvas;
      },
      async loadAsset(src) {
        // prepareArtwork never loads template assets; only mockups do.
        throw new Error(`Print generation loads no template assets (requested ${src}).`);
      },
    },

    async loadOrder(orderId): Promise<FulfilmentOrder | null> {
      const { data } = await db
        .from('orders')
        .select(
          `id, status, fulfilment_status, shipping_address,
           order_items (
             id, variant_id, quantity,
             designs ( spec, project_images ( storage_path ) ),
             product_variants ( config, product_templates ( config ) )
           )`,
        )
        .eq('id', orderId)
        .maybeSingle();
      if (!data) return null;
      // Untyped-client join quirk: many-to-one arrives as an object.
      const row = data as unknown as {
        id: string;
        status: string;
        fulfilment_status: string;
        shipping_address: FulfilmentOrder['address'];
        order_items: Array<{
          id: string;
          variant_id: string;
          quantity: number;
          designs: { spec: unknown; project_images: { storage_path: string } };
          product_variants: { config: unknown; product_templates: { config: unknown } };
        }>;
      };
      return {
        id: row.id,
        status: row.status,
        fulfilmentStatus: row.fulfilment_status,
        address: row.shipping_address,
        items: row.order_items.map((item) => ({
          itemId: item.id,
          variantId: item.variant_id,
          quantity: item.quantity,
          spec: item.designs.spec,
          templateConfig: item.product_variants.product_templates.config,
          variantConfig: item.product_variants.config,
          artworkPath: item.designs.project_images.storage_path,
        })),
      };
    },

    async loadArtwork(storagePath): Promise<SourceImage> {
      const { data, error } = await db.storage.from('uploads').download(storagePath);
      if (error || !data) {
        throw new Error(`Could not load the customer's photo (${storagePath}).`);
      }
      const { Image } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
      const img = new Image();
      img.src = Buffer.from(await data.arrayBuffer());
      return img as unknown as SourceImage;
    },

    async encode(canvas, format: PrintFormat): Promise<Uint8Array> {
      const c = canvas as unknown as import('@napi-rs/canvas').Canvas;
      return format === 'jpeg' ? c.encode('jpeg', 95) : c.encode('png');
    },

    async storePrintFile(orderId, itemIndex, bytes, format) {
      const path = `${orderId}/item-${itemIndex}.${format === 'jpeg' ? 'jpg' : 'png'}`;
      const { error } = await db.storage.from('prints').upload(path, bytes, {
        contentType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        upsert: true, // retries regenerate; the newest render wins
      });
      if (error) throw new Error(`Could not store the print file: ${error.message}`);
      return path;
    },

    async signPrintFile(path) {
      const { data, error } = await db.storage.from('prints').createSignedUrl(path, 60 * 60 * 24);
      if (error || !data) throw new Error('Could not sign the print file for the provider.');
      return data.signedUrl;
    },

    async setItemPrintFile(itemId, path) {
      await db.from('order_items').update({ print_file_url: path }).eq('id', itemId);
    },

    async setFulfilment(orderId, status, response) {
      await db
        .from('orders')
        .update({
          fulfilment_status: status,
          provider_response: (response ?? null) as import('../../types/database').Json,
        })
        .eq('id', orderId);
    },

    registry,

    async loadMappings(variantIds) {
      const { data } = await db
        .from('provider_mappings')
        .select('variant_id, provider, provider_product_id, provider_variant_id, priority')
        .in('variant_id', variantIds);
      const map = new Map<string, MappingRow[]>();
      for (const row of (data ?? []) as Array<{
        variant_id: string;
        provider: string;
        provider_product_id: string;
        provider_variant_id: string;
        priority: number;
      }>) {
        const list = map.get(row.variant_id) ?? [];
        list.push({
          provider: row.provider,
          priority: row.priority,
          providerProductId: row.provider_product_id,
          providerVariantId: row.provider_variant_id,
        });
        map.set(row.variant_id, list);
      }
      return map;
    },
  };
}
