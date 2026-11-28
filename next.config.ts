import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // No framework banner in every response.
  poweredByHeader: false,
  allowedDevOrigins: ["*.vercel.run", "preview-check.vercel.run:3000", "localhost:3000", "127.0.0.1:3000"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
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
