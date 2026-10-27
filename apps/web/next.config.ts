import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace dependencies from the repo root so the standalone build is self-contained.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@stellar-health/ui', '@stellar-health/shared-types'],
  poweredByHeader: false,
  // The dashboard serves no remote or user images. Disabling the optimizer removes the
  // /_next/image attack surface (e.g. GHSA-2464-fhr4-w9xw); the middleware also blocks the route.
  images: { unoptimized: true },
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
