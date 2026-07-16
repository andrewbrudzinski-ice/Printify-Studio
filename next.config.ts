import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @napi-rs/canvas is a native module used for print generation in the
  // Stripe webhook. Without this, the build fails trying to parse a .node
  // binary as JavaScript.
  serverExternalPackages: ['@napi-rs/canvas'],
};

export default nextConfig;
