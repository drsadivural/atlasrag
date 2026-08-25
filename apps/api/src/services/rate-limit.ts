export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  reset(bucket: string): Promise<void>;
}

/**
 * Fixed-window counters with a sliding correction.
 *
 * A plain fixed window lets a caller send `2 x limit` requests across a window boundary. The
 * previous window's count is therefore weighted by how much of it still overlaps the
 * trailing period, which smooths that burst without the memory cost of storing every
 * timestamp. This is the same approach Cloudflare's own rate limiter uses.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<
    string,
    { windowStart: number; count: number; previous: number }
  >();
  private lastSweep = Date.now();

  async check(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now, windowSeconds);

    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const entry = this.windows.get(bucket);

    let current: { windowStart: number; count: number; previous: number };
    if (!entry) {
      current = { windowStart, count: 0, previous: 0 };
    } else if (entry.windowStart === windowStart) {
      current = entry;
    } else if (entry.windowStart === windowStart - windowMs) {
      current = { windowStart, count: 0, previous: entry.count };
    } else {
      current = { windowStart, count: 0, previous: 0 };
    }

    const elapsedFraction = (now - windowStart) / windowMs;
    const weighted = current.previous * (1 - elapsedFraction) + current.count;
    const resetAt = new Date(windowStart + windowMs);

    if (weighted >= limit) {
      this.windows.set(bucket, current);
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
      };
    }

    current.count += 1;
    this.windows.set(bucket, current);

    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(limit - weighted - 1)),
      limit,
      resetAt,
      retryAfterSeconds: 0,
    };
  }

  /** Test-only: clears every window so one case cannot rate-limit the next. */
  resetAll(): void {
    this.windows.clear();
  }

  async reset(bucket: string): Promise<void> {
    this.windows.delete(bucket);
  }

  /** Drops entries older than two windows so the map cannot grow without bound. */
  private sweep(now: number, windowSeconds: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - windowSeconds * 2000;
    for (const [key, entry] of this.windows) {
      if (entry.windowStart < cutoff) this.windows.delete(key);
    }
  }
}

/**
 * Workers KV-backed limiter for production, where requests are spread across isolates and
 * an in-memory counter would only limit a single instance.
 */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KvRateLimiter implements RateLimiter {
  constructor(private readonly kv: KvNamespaceLike) {}

  async check(bucket: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `rl:${bucket}:${windowStart}`;
    const resetAt = new Date(windowStart + windowMs);

    const raw = await this.kv.get(key);
    const count = raw ? Number.parseInt(raw, 10) : 0;

    if (count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        limit,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
      };
    }

    // KV is eventually consistent, so a small over-count is possible under heavy
    // concurrency. That is an acceptable trade for a limiter; anything requiring exactness
    // (billing, quotas) uses the database counter instead.
    await this.kv.put(key, String(count + 1), { expirationTtl: windowSeconds * 2 });

    return { allowed: true, remaining: limit - count - 1, limit, resetAt, retryAfterSeconds: 0 };
  }

  async reset(bucket: string): Promise<void> {
    const now = Date.now();
    await this.kv.delete(`rl:${bucket}:${Math.floor(now / 60000) * 60000}`);
  }
}

/**
 * Bucket keys.
 *
 * Login is keyed by BOTH the IP and the email so that neither dimension alone can be used
 * to lock somebody out: an attacker spraying one address is throttled by IP, and an
 * attacker spraying many addresses from many IPs is still throttled per account.
 */
export const RateLimitBuckets = {
  loginByIp: (ip: string) => `login:ip:${ip}`,
  loginByEmail: (email: string) => `login:email:${email.toLowerCase()}`,
  passwordReset: (email: string) => `reset:${email.toLowerCase()}`,
  registration: (ip: string) => `register:${ip}`,
  apiByUser: (userId: string) => `api:user:${userId}`,
  apiByIp: (ip: string) => `api:ip:${ip}`,
  uploadByWorkspace: (workspaceId: string) => `upload:ws:${workspaceId}`,
  consultByWorkspace: (workspaceId: string) => `consult:ws:${workspaceId}`,
  mfaByUser: (userId: string) => `mfa:user:${userId}`,
} as const;
