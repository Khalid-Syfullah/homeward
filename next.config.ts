import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root to this repo (a lockfile higher up the disk would otherwise be picked).
  turbopack: { root: __dirname },
  async headers() {
    // Frame folders are renamed to bust caches (docs/ARCHITECTURE.md), but in development the
    // placeholders and art:import rewrite them in place, so only production gets immutable caching.
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/frames/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
