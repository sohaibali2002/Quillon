import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.vercel.run"],
  async rewrites() {
    return {
      beforeFiles: [
        // The preview harness probes this path to confirm the app answers at the
        // preview origin; without it the probe lands on the framework's 404.
        { source: "/_next/mlai-origin-probe", destination: "/api/health" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
