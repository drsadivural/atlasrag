import { lookup } from 'node:dns/promises';

export interface UrlFetchPolicy {
  allowedSchemes: string[];
  blockPrivateNetworks: boolean;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  allowedDomains?: string[];
}

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'scheme_not_allowed'
      | 'private_address'
      | 'domain_not_allowed'
      | 'too_many_redirects'
      | 'too_large'
      | 'timeout'
      | 'blocked_by_robots'
      | 'unreachable',
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Ranges that must never be reachable from a user-supplied URL.
 *
 * The cloud metadata endpoint (169.254.169.254) is the one that matters most: fetching it
 * from inside the platform would hand instance credentials to whoever supplied the URL.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped addresses (::ffff:169.254.169.254) must be checked as IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

/**
 * Resolves the hostname and rejects the request if ANY resolved address is private.
 *
 * Checking every address (not just the first) closes the DNS rebinding window where a
 * hostname resolves to one public and one private address.
 */
export async function assertPublicHost(hostname: string, resolver = lookup): Promise<string[]> {
  // A literal IP in the URL never reaches DNS, so check it directly.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfError('That address is not reachable from this service.', 'private_address');
    }
    return [hostname];
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(hostname, { all: true });
  } catch {
    throw new SsrfError('That hostname could not be resolved.', 'unreachable');
  }

  if (addresses.length === 0) {
    throw new SsrfError('That hostname could not be resolved.', 'unreachable');
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfError('That address is not reachable from this service.', 'private_address');
    }
  }
  return addresses.map((a) => a.address);
}

export interface FetchedResource {
  url: string;
  finalUrl: string;
  contentType: string;
  bytes: Uint8Array;
  status: number;
}

/**
 * SSRF-safe fetch used for website ingestion.
 *
 * Redirects are followed manually so every hop is re-validated: a public URL that 302s to
 * `http://169.254.169.254/` is exactly the attack this guards against, and letting `fetch`
 * follow redirects internally would skip the check on every hop after the first.
 */
export async function safeFetch(
  rawUrl: string,
  policy: UrlFetchPolicy,
  fetchImpl: typeof fetch = fetch,
  resolver = lookup,
): Promise<FetchedResource> {
  let current = rawUrl;

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    const url = new URL(current);

    const scheme = url.protocol.replace(':', '');
    if (!policy.allowedSchemes.includes(scheme)) {
      throw new SsrfError(
        `Only ${policy.allowedSchemes.join(', ')} URLs can be ingested.`,
        'scheme_not_allowed',
      );
    }

    if (policy.allowedDomains && policy.allowedDomains.length > 0) {
      const host = url.hostname.toLowerCase();
      const allowed = policy.allowedDomains.some(
        (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`),
      );
      if (!allowed) {
        throw new SsrfError(
          `${url.hostname} is not on the allowlist for this connector.`,
          'domain_not_allowed',
        );
      }
    }

    if (policy.blockPrivateNetworks) await assertPublicHost(url.hostname, resolver);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'UXE-Consulting-AI/1.0 (+https://uxe.example.com/bot)',
          accept: 'text/html,application/pdf,text/plain;q=0.9,*/*;q=0.8',
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SsrfError('That URL did not respond in time.', 'timeout');
      }
      throw new SsrfError('That URL could not be reached.', 'unreachable');
    }
    clearTimeout(timeout);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location)
        throw new SsrfError('That URL redirected without a destination.', 'unreachable');
      current = new URL(location, url).toString();
      continue;
    }

    // Trust the declared length when present, but still enforce the cap while reading,
    // because a hostile server can simply lie about Content-Length.
    const declared = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
    if (Number.isFinite(declared) && declared > policy.maxBytes) {
      throw new SsrfError('That resource is larger than the ingestion limit.', 'too_large');
    }

    const bytes = await readCapped(response, policy.maxBytes);

    return {
      url: rawUrl,
      finalUrl: url.toString(),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes,
      status: response.status,
    };
  }

  throw new SsrfError('That URL redirected too many times.', 'too_many_redirects');
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SsrfError('That resource is larger than the ingestion limit.', 'too_large');
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Minimal robots.txt evaluation for the user-agent this crawler presents. */
export function isAllowedByRobots(
  robotsTxt: string,
  path: string,
  userAgent = 'UXE-Consulting-AI',
): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let applies = false;
  let sawSpecificGroup = false;
  const rules: Array<{ allow: boolean; path: string }> = [];

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      const agent = value.toLowerCase();
      const matchesUs = agent === userAgent.toLowerCase();
      if (matchesUs) sawSpecificGroup = true;
      applies = matchesUs || (agent === '*' && !sawSpecificGroup);
      continue;
    }
    if (!applies) continue;
    if (key === 'disallow' && value) rules.push({ allow: false, path: value });
    if (key === 'allow' && value) rules.push({ allow: true, path: value });
  }

  // Longest matching rule wins, and Allow beats Disallow at equal length (RFC 9309).
  let decision = true;
  let bestLength = -1;
  for (const rule of rules) {
    if (!path.startsWith(rule.path)) continue;
    if (rule.path.length > bestLength || (rule.path.length === bestLength && rule.allow)) {
      bestLength = rule.path.length;
      decision = rule.allow;
    }
  }
  return decision;
}

/** Canonicalises a URL so the same page fetched two ways produces one source. */
export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  // Drop tracking parameters that create duplicate copies of the same document.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_[a-z0-9_]*|fbclid|gclid|msclkid|mc_[ce]id|ref|source)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}
