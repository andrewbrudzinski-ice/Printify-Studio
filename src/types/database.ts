// HAND-WRITTEN database types, faithful to supabase/schema.sql.
//
// These exist to make `tsc` meaningful before a Supabase project exists:
// column typos and wrong-table queries fail the typecheck instead of
// production. They WILL drift from the real database over time — regenerate
// the moment you have a project, and treat the generated file as the truth:
//
//   npx supabase gen types typescript --linked > src/types/database.ts
//
// Until then, keep this file in lockstep with schema.sql by hand.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      users: {
        Row: {
          id: string;
          email: string;
          role: string;
          referral_code: string | null;
          referred_by: string | null;
          store_credit: number;
          loyalty_points: number;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          role?: string;
          referral_code?: string | null;
          referred_by?: string | null;
          store_credit?: number;
          loyalty_points?: number;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['users']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'users_referred_by_fkey';
            columns: ['referred_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      product_templates: {
        Row: {
          id: string;
          slug: string;
          name: string;
          description: string;
          config: Json;
          mockup_layers: Json;
          ai_tags: string[];
          active: boolean;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          slug: string;
          name: string;
          description?: string;
          config: Json;
          mockup_layers?: Json;
          ai_tags?: string[];
          active?: boolean;
          sort_order?: number;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['product_templates']['Insert']>;
        Relationships: [];
      };
      product_variants: {
        Row: {
          id: string;
          template_id: string;
          sku: string;
          name: string;
          price: number;
          config: Json | null;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          template_id: string;
          sku: string;
          name: string;
          price: number;
          config?: Json | null;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['product_variants']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'product_variants_template_id_fkey';
            columns: ['template_id'];
            isOneToOne: false;
            referencedRelation: 'product_templates';
            referencedColumns: ['id'];
          },
        ];
      };
      collections: {
        Row: { id: string; slug: string; name: string; description: string; sort_order: number };
        Insert: { id?: string; slug: string; name: string; description?: string; sort_order?: number };
        Update: Partial<Database['public']['Tables']['collections']['Insert']>;
        Relationships: [];
      };
      collection_items: {
        Row: { collection_id: string; template_id: string; sort_order: number };
        Insert: { collection_id: string; template_id: string; sort_order?: number };
        Update: Partial<Database['public']['Tables']['collection_items']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'collection_items_collection_id_fkey';
            columns: ['collection_id'];
            isOneToOne: false;
            referencedRelation: 'collections';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'collection_items_template_id_fkey';
            columns: ['template_id'];
            isOneToOne: false;
            referencedRelation: 'product_templates';
            referencedColumns: ['id'];
          },
        ];
      };
      bundles: {
        Row: {
          id: string;
          name: string;
          skus: string[];
          quantity: number;
          reward: Json;
          priority: number;
          active: boolean;
        };
        Insert: {
          id: string;
          name: string;
          skus: string[];
          quantity: number;
          reward: Json;
          priority?: number;
          active?: boolean;
        };
        Update: Partial<Database['public']['Tables']['bundles']['Insert']>;
        Relationships: [];
      };
      discounts: {
        Row: {
          code: string;
          kind: string;
          value: number;
          active: boolean;
          expires_at: string | null;
          max_redemptions: number | null;
          redemptions: number;
        };
        Insert: {
          code: string;
          kind: string;
          value: number;
          active?: boolean;
          expires_at?: string | null;
          max_redemptions?: number | null;
          redemptions?: number;
        };
        Update: Partial<Database['public']['Tables']['discounts']['Insert']>;
        Relationships: [];
      };
      projects: {
        Row: { id: string; user_id: string | null; anon_token: string | null; created_at: string };
        Insert: { id?: string; user_id?: string | null; anon_token?: string | null; created_at?: string };
        Update: Partial<Database['public']['Tables']['projects']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'projects_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      project_images: {
        Row: {
          id: string;
          project_id: string;
          storage_path: string;
          width: number;
          height: number;
          analysis: Json | null;
          ai_tags: string[];
          cutout_status: string;
          cutout_path: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          storage_path: string;
          width: number;
          height: number;
          analysis?: Json | null;
          ai_tags?: string[];
          cutout_status?: string;
          cutout_path?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['project_images']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'project_images_project_id_fkey';
            columns: ['project_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
        ];
      };
      designs: {
        Row: {
          id: string;
          user_id: string | null;
          project_id: string;
          image_id: string;
          template_id: string;
          spec: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          project_id: string;
          image_id: string;
          template_id: string;
          spec: Json;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['designs']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'designs_project_id_fkey';
            columns: ['project_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'designs_image_id_fkey';
            columns: ['image_id'];
            isOneToOne: false;
            referencedRelation: 'project_images';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'designs_template_id_fkey';
            columns: ['template_id'];
            isOneToOne: false;
            referencedRelation: 'product_templates';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'designs_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      orders: {
        Row: {
          id: string;
          user_id: string | null;
          email: string;
          status: string;
          fulfilment_status: string;
          stripe_session_id: string | null;
          subtotal: number;
          discount_total: number;
          tax: number;
          shipping: number;
          total: number;
          currency: string;
          shipping_address: Json | null;
          provider_response: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          email: string;
          status?: string;
          fulfilment_status?: string;
          stripe_session_id?: string | null;
          subtotal: number;
          discount_total?: number;
          tax?: number;
          shipping?: number;
          total: number;
          currency?: string;
          shipping_address?: Json | null;
          provider_response?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['orders']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'orders_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      order_items: {
        Row: {
          id: string;
          order_id: string;
          design_id: string;
          variant_id: string;
          quantity: number;
          unit_price: number;
          print_file_url: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          order_id: string;
          design_id: string;
          variant_id: string;
          quantity: number;
          unit_price: number;
          print_file_url?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['order_items']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'order_items_order_id_fkey';
            columns: ['order_id'];
            isOneToOne: false;
            referencedRelation: 'orders';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_items_design_id_fkey';
            columns: ['design_id'];
            isOneToOne: false;
            referencedRelation: 'designs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'order_items_variant_id_fkey';
            columns: ['variant_id'];
            isOneToOne: false;
            referencedRelation: 'product_variants';
            referencedColumns: ['id'];
          },
        ];
      };
      provider_mappings: {
        Row: {
          id: string;
          variant_id: string;
          provider: string;
          provider_product_id: string;
          provider_variant_id: string;
          cost: number;
          priority: number;
        };
        Insert: {
          id?: string;
          variant_id: string;
          provider: string;
          provider_product_id: string;
          provider_variant_id: string;
          cost: number;
          priority?: number;
        };
        Update: Partial<Database['public']['Tables']['provider_mappings']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'provider_mappings_variant_id_fkey';
            columns: ['variant_id'];
            isOneToOne: false;
            referencedRelation: 'product_variants';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      claim_anon_projects: { Args: { p_token: string }; Returns: number };
      is_admin: { Args: Record<string, never>; Returns: boolean };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
