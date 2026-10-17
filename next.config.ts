import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module: load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["better-sqlite3"],
  devIndicators: false,
};

export default nextConfig;
