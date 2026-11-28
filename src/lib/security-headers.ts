// Response security headers, defined once and applied to every route.
//
// Kept as plain data so the regression suite can assert the policy without
// booting Next. The CSP has to stay compatible with the framework: App Router
// emits inline bootstrap scripts and inline styles, so those keep
// 'unsafe-inline'; everything else is same-origin only.
export type Header = { key: string; value: string };

export function securityHeaders(nodeEnv: string | undefined = process.env.NODE_ENV): Header[] {
  const dev = nodeEnv !== "production";
  const scriptSrc = dev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    // Only honoured over HTTPS, so it is safe on plain-HTTP preview origins.
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), payment=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    // No legacy Flash/PDF cross-domain policy to honour.
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];
}
