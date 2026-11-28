// Outbound egress guard: SSRF defence for every URL the platform fetches on a
// user's behalf (remote MCP servers, connector base URLs, discovery documents).
//
// A destination is allowed only when the URL carries no credentials, its
// hostname is not a known metadata/local name, every DNS answer for it is a
// public unicast address, and — when an allowlist is configured — it matches
// that allowlist. Redirects are followed by hand so each hop is revalidated
// against the same rules instead of trusting the first host.
//
// DNS answers are checked immediately before the connection, which narrows but
// does not eliminate rebinding; production egress should also be deny-by-
// default at the network layer (see README "Network isolation").
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type LookupResult = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<LookupResult[]>;

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata",
]);

const METADATA_IPS = new Set([
  "169.254.169.254", // AWS / Azure / GCP / OpenStack IMDS
  "169.254.170.2", // ECS task credentials
  "100.100.100.200", // Alibaba Cloud IMDS
  "192.0.0.192", // Oracle Cloud IMDS
]);

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function ipv4PrivateReason(ip: string): string | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "invalid IPv4";
  const [a, b] = parts;
  if (METADATA_IPS.has(ip)) return "cloud metadata address";
  if (a === 0) return "reserved 0.0.0.0/8";
  if (a === 10) return "private 10/8";
  if (a === 127) return "loopback 127/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64/10";
  if (a === 169 && b === 254) return "link-local 169.254/16";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16/12";
  if (a === 192 && b === 0) return "reserved 192.0.0/24";
  if (a === 192 && b === 168) return "private 192.168/16";
  if (a === 192 && b === 88 && parts[2] === 99) return "reserved 192.88.99/24";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark 198.18/15";
  if (a === 198 && b === 51 && parts[2] === 100) return "documentation 198.51.100/24";
  if (a === 203 && b === 0 && parts[2] === 113) return "documentation 203.0.113/24";
  if (a === 192 && b === 0 && parts[2] === 2) return "documentation 192.0.2/24";
  if (a >= 224 && a <= 239) return "multicast 224/4";
  if (a >= 240) return "reserved 240/4";
  return null;
}

function expandIpv6(ip: string): number[] | null {
  const zone = ip.indexOf("%");
  const bare = zone >= 0 ? ip.slice(0, zone) : ip;
  const [head, tail] = bare.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail ? tail.split(":") : [];
  const toWords = (parts: string[]) => {
    const words: number[] = [];
    for (const part of parts) {
      if (!part) return null;
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        words.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
        words.push(parseInt(part, 16));
      }
    }
    return words;
  };
  const headWords = toWords(headParts);
  const tailWords = toWords(tailParts);
  if (!headWords || !tailWords) return null;
  const fill = tail === undefined ? 0 : 8 - headWords.length - tailWords.length;
  if (tail === undefined ? headWords.length !== 8 : fill < 0) return null;
  return [...headWords, ...Array(fill).fill(0), ...tailWords];
}

/** Why an address must not be reached, or null when it is public unicast. */
export function addressBlockReason(ip: string): string | null {
  const kind = isIP(ip);
  if (kind === 4) return ipv4PrivateReason(ip);
  if (kind !== 6) return "not an IP address";
  const words = expandIpv6(ip);
  if (!words) return "invalid IPv6";
  const [w0, w1, w2, w3] = words;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64
  // (64:ff9b::/96) and 6to4 (2002::/16) all embed an IPv4 address that must be
  // judged by IPv4 rules — otherwise ::ffff:127.0.0.1 walks straight past.
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0) {
    const v4 = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".");
    if (words[5] === 0xffff) return ipv4PrivateReason(v4) ?? "IPv4-mapped IPv6";
    if (words[5] === 0 && (words[6] !== 0 || words[7] > 1)) return ipv4PrivateReason(v4) ?? null;
  }
  if (w0 === 0x64 && w1 === 0xff9b) {
    const v4 = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".");
    return ipv4PrivateReason(v4) ?? null;
  }
  if (w0 === 0x2002) {
    const v4 = [words[1] >> 8, words[1] & 255, words[2] >> 8, words[2] & 255].join(".");
    return ipv4PrivateReason(v4) ?? null;
  }
  if (words.every((w) => w === 0)) return "unspecified ::";
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return "loopback ::1";
  if ((w0 & 0xfe00) === 0xfc00) return "unique-local fc00::/7";
  if ((w0 & 0xffc0) === 0xfe80) return "link-local fe80::/10";
  if ((w0 & 0xff00) === 0xff00) return "multicast ff00::/8";
  if (w0 === 0x2001 && w1 === 0x0db8) return "documentation 2001:db8::/32";
  if (w0 === 0xfd00 && w1 === 0x0ec2) return "cloud metadata fd00:ec2::/32";
  return null;
}

/** Allowlist from QUILLON_EGRESS_ALLOWLIST or QUILLON_MCP_ALLOWED_HOSTS. */
export function egressAllowlist(): string[] {
  return (process.env.QUILLON_EGRESS_ALLOWLIST ?? process.env.QUILLON_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function allowlisted(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

/**
 * Internal destinations an operator approved explicitly. An allowlisted host
 * that must resolve to a private address belongs here; the allowlist alone is
 * not permission to reach the private network.
 */
function privateDestinationApproved(hostname: string): boolean {
  return (process.env.QUILLON_EGRESS_PRIVATE_HOSTS ?? "")
    .split(",")
    .map((h) => normaliseHost(h))
    .filter(Boolean)
    .some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

function normaliseHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
}

const SECRET_QUERY_KEYS =
  /^(access_token|api[_-]?key|apikey|auth|authorization|bearer|client[_-]?secret|key|password|passwd|secret|sig|signature|token|code)$/i;

/** Rejects credentials smuggled into a URL, where they would land in plaintext metadata. */
export function urlCredentialReason(url: URL): string | null {
  if (url.username || url.password) return "URL must not embed credentials; use an encrypted secret field";
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.test(key)) {
      return `URL query parameter "${key}" looks like a credential; store secrets in the encrypted env field`;
    }
  }
  return null;
}

export type DestinationPolicy = {
  /** Explicit host allowlist; defaults to the env allowlist. */
  allowlist?: string[];
  /** Allow loopback/private addresses (local MCP servers during development). */
  allowPrivate?: boolean;
  /** Injectable resolver for tests. */
  resolver?: DnsResolver;
};

async function resolveAll(hostname: string, resolver?: DnsResolver): Promise<LookupResult[]> {
  const fn: DnsResolver =
    resolver ?? (async (h) => (await dnsLookup(h, { all: true })) as LookupResult[]);
  const answers = await fn(hostname);
  if (!answers.length) throw new Error(`Host ${hostname} did not resolve.`);
  return answers;
}

/**
 * Throws unless `input` is a safe outbound destination. Returns the parsed URL
 * so callers validate and parse in one step.
 */
export async function assertPublicDestination(
  input: string | URL,
  policy: DestinationPolicy = {},
): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new Error("Destination is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Destination must use http(s).");
  }
  const credential = urlCredentialReason(url);
  if (credential) throw new Error(credential);

  const hostname = normaliseHost(url.hostname);
  const allowlist = policy.allowlist ?? egressAllowlist();
  const allowed = allowlisted(hostname, allowlist);

  // The allowlist chooses *which* hosts may be reached; it never switches off
  // address validation. An allowlisted name that resolves to loopback, a
  // private range or a cloud-metadata endpoint is still refused unless the
  // operator approved that exact internal destination in
  // QUILLON_EGRESS_PRIVATE_HOSTS (and allowlisted it too). Cloud-metadata
  // endpoints stay blocked even when approved.
  if (!policy.allowPrivate) {
    const blockMetadata = (via: string) => {
      throw new Error(`Destination ${hostname}${via} is a cloud-metadata endpoint and is always blocked.`);
    };
    const approved = allowed && privateDestinationApproved(hostname);
    const literal = isIP(hostname) !== 0;

    // Metadata is never reachable, approved or not.
    if (literal && METADATA_IPS.has(hostname)) blockMetadata("");
    if (!approved) {
      if (METADATA_HOSTS.has(hostname)) blockMetadata("");
      if (LOOPBACK_NAMES.has(hostname)) {
        throw new Error(`Destination ${hostname} is a local or cloud-metadata host and is blocked.`);
      }
      if (literal) {
        const reason = addressBlockReason(hostname);
        if (reason) {
          throw new Error(
            `Destination ${hostname} is blocked (${reason}); add it to QUILLON_EGRESS_ALLOWLIST and QUILLON_EGRESS_PRIVATE_HOSTS to reach an internal service.`,
          );
        }
      } else {
        const answers = await resolveAll(hostname, policy.resolver);
        for (const answer of answers) {
          const reason = addressBlockReason(answer.address);
          if (reason) {
            throw new Error(
              allowed
                ? `Destination ${hostname} is allowlisted but resolves to a blocked address (${reason}); add it to QUILLON_EGRESS_PRIVATE_HOSTS to reach an internal service.`
                : `Destination ${hostname} resolves to a blocked address (${reason}).`,
            );
          }
        }
      }
    } else if (!literal) {
      // Approved: private ranges are trusted, but a name that resolves to a
      // cloud-metadata address is still refused. A name that does not resolve
      // from this host is allowed — the operator vouched for it.
      let answers: LookupResult[] | null = null;
      try {
        answers = await resolveAll(hostname, policy.resolver);
      } catch {
        answers = null;
      }
      for (const answer of answers ?? []) {
        if (METADATA_IPS.has(answer.address)) blockMetadata(" resolves to");
      }
    }
  }
  return url;
}

export type GuardedFetchOptions = Omit<RequestInit, "redirect"> & {
  maxRedirects?: number;
  policy?: DestinationPolicy;
};

/**
 * fetch() that validates the destination and every redirect hop. `redirect` is
 * always "manual" so a 30x to an internal host cannot slip past the check.
 */
export async function guardedFetch(input: RequestInfo | URL, init: GuardedFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 5, policy, ...rest } = init;
  let url = await assertPublicDestination(typeof input === "string" ? input : input instanceof URL ? input : input.url, policy);
  let method = (rest.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
  let body = rest.body;
  let headers = rest.headers;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(url, {
      ...rest,
      method,
      body,
      headers,
      redirect: "manual",
      signal: rest.signal ?? AbortSignal.timeout(20_000),
    });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop === maxRedirects) throw new Error("Too many redirects.");
    const next = new URL(location, url);
    url = await assertPublicDestination(next, policy);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = undefined;
    }
    await res.body?.cancel().catch(() => {});
  }
  throw new Error("Too many redirects.");
}
