// Per-identity rate limits for the routes that cost money or touch state.
//
// A fixed window per (route, identity) is enough to stop one caller from
// exhausting model budget, connector quota or the transaction engine: the goal
// is bounding abuse, not shaping traffic. State lives in this process, so a
// multi-instance deployment must move the same table to Redis — the interface
// is deliberately one function so that swap stays local.
export type LimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, b] of buckets) if (now >= b.resetAt) buckets.delete(key);
  // Still full of live buckets: drop the oldest half rather than grow forever.
  if (buckets.size >= MAX_BUCKETS) {
    let drop = Math.floor(buckets.size / 2);
    for (const key of buckets.keys()) {
      if (drop-- <= 0) break;
      buckets.delete(key);
    }
  }
}

/** Counts one hit for `key`; pure enough to test by passing `now`. */
export function take(key: string, limit: number, windowMs: number, now = Date.now()): LimitVerdict {
  if (limit <= 0) return { ok: false, retryAfterMs: windowMs };
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) return { ok: false, retryAfterMs: bucket.resetAt - now };
  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count };
}

/** Test hook: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Applies a limit to a request and returns a ready-made 429, or null when the
 * caller is within budget. `identity` should include the tenant so one tenant
 * cannot spend another's allowance.
 */
export function enforceRateLimit(
  identity: string,
  route: string,
  limit: number,
  windowMs: number,
): Response | null {
  const verdict = take(`${route}:${identity}`, limit, windowMs);
  if (verdict.ok) return null;
  const seconds = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
  return Response.json(
    {
      error: {
        code: "rate_limited",
        message: `Too many requests. Retry in ${seconds}s.`,
      },
    },
    { status: 429, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } },
  );
}
