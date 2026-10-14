import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static output (out/), served by the Worker as static assets
  output: "export",
  images: { unoptimized: true },
  // Shared API types/constants live in a workspace package shipped as TypeScript source.
  transpilePackages: ["@pingward/shared"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
