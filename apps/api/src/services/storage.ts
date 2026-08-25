import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { hmacSha256, timingSafeEqual } from '@uxe/auth';

export interface PutResult {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface StorageDriver {
  readonly id: 'filesystem' | 's3';
  put(
    bucket: 'originals' | 'artifacts',
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<PutResult>;
  get(bucket: 'originals' | 'artifacts', key: string): Promise<Uint8Array | null>;
  delete(bucket: 'originals' | 'artifacts', key: string): Promise<boolean>;
  exists(bucket: 'originals' | 'artifacts', key: string): Promise<boolean>;
  /** Short-lived, signed. Never a durable public link. */
  signedDownloadUrl(
    bucket: 'originals' | 'artifacts',
    key: string,
    fileName: string,
    ttlSeconds: number,
  ): Promise<SignedUrl>;
  verifySignature(params: URLSearchParams, bucket: string, key: string): Promise<boolean>;
  health(): Promise<{ ok: boolean; detail: string | null }>;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as ArrayBufferView);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Storage keys are server-generated, but they are still validated before touching the
 * filesystem. A key containing `..` or an absolute path would otherwise let a future
 * caller read or overwrite anything the process can reach.
 */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 512) throw new Error('Invalid storage key');
  if (key.startsWith('/') || key.includes('\0')) throw new Error('Invalid storage key');
  const normalized = normalize(key);
  if (normalized.startsWith('..') || normalized.includes(`..${sep}`)) {
    throw new Error('Invalid storage key');
  }
}

/**
 * Local development driver. Refused in production by `loadEnv`, because it offers none of
 * the durability, replication or access controls a private R2 bucket does.
 */
export class FilesystemStorage implements StorageDriver {
  readonly id = 'filesystem' as const;

  constructor(
    private readonly rootPath: string,
    private readonly signingSecret: string,
    private readonly publicApiUrl: string,
  ) {}

  private pathFor(bucket: string, key: string): string {
    assertSafeKey(key);
    const root = resolve(this.rootPath, bucket);
    const target = resolve(root, key);
    // Belt and braces: confirm the resolved path really is inside the bucket root.
    if (!target.startsWith(root + sep) && target !== root) {
      throw new Error('Invalid storage key');
    }
    return target;
  }

  async put(
    bucket: 'originals' | 'artifacts',
    key: string,
    body: Uint8Array,
    _contentType: string,
  ) {
    const target = this.pathFor(bucket, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key, sizeBytes: body.byteLength, sha256: await sha256Of(body) };
  }

  async get(bucket: 'originals' | 'artifacts', key: string) {
    try {
      return new Uint8Array(await readFile(this.pathFor(bucket, key)));
    } catch {
      return null;
    }
  }

  async delete(bucket: 'originals' | 'artifacts', key: string) {
    try {
      await rm(this.pathFor(bucket, key));
      return true;
    } catch {
      return false;
    }
  }

  async exists(bucket: 'originals' | 'artifacts', key: string) {
    try {
      await stat(this.pathFor(bucket, key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Produces an HMAC-signed, expiring URL served by the API itself.
   *
   * The signature covers the bucket, key and expiry, so a leaked link cannot be edited to
   * point at a different object or to extend its own lifetime.
   */
  async signedDownloadUrl(
    bucket: 'originals' | 'artifacts',
    key: string,
    fileName: string,
    ttlSeconds: number,
  ): Promise<SignedUrl> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = await hmacSha256(this.signingSecret, `${bucket}:${key}:${expires}`);
    const params = new URLSearchParams({
      key,
      expires: String(expires),
      signature,
      filename: fileName,
    });
    return {
      url: `${this.publicApiUrl}/api/v1/storage/${bucket}?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  async verifySignature(params: URLSearchParams, bucket: string, key: string): Promise<boolean> {
    const expires = Number.parseInt(params.get('expires') ?? '0', 10);
    const signature = params.get('signature') ?? '';
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = await hmacSha256(this.signingSecret, `${bucket}:${key}:${expires}`);
    return timingSafeEqual(signature, expected);
  }

  async health() {
    try {
      await mkdir(this.rootPath, { recursive: true });
      const probe = join(this.rootPath, '.health');
      await writeFile(probe, 'ok');
      await rm(probe);
      return { ok: true, detail: null };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }

  streamFor(bucket: 'originals' | 'artifacts', key: string) {
    return createReadStream(this.pathFor(bucket, key));
  }
}

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketOriginals: string;
  bucketArtifacts: string;
}

/**
 * S3-compatible driver targeting Cloudflare R2.
 *
 * Requests are signed with SigV4 computed through WebCrypto, so the driver works unchanged
 * inside a Worker where the AWS SDK's Node dependencies are unavailable. Buckets stay
 * private; the browser only ever receives a presigned URL with a short expiry.
 */
export class S3Storage implements StorageDriver {
  readonly id = 's3' as const;

  constructor(
    private readonly config: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private bucketName(bucket: 'originals' | 'artifacts'): string {
    return bucket === 'originals' ? this.config.bucketOriginals : this.config.bucketArtifacts;
  }

  private urlFor(bucket: 'originals' | 'artifacts', key: string): URL {
    assertSafeKey(key);
    const base = this.config.endpoint.replace(/\/$/, '');
    return new URL(`${base}/${this.bucketName(bucket)}/${encodeKey(key)}`);
  }

  async put(bucket: 'originals' | 'artifacts', key: string, body: Uint8Array, contentType: string) {
    const url = this.urlFor(bucket, key);
    const payloadHash = await sha256Of(body);
    const headers = await signRequest({
      method: 'PUT',
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payloadHash,
      extraHeaders: { 'content-type': contentType },
    });

    const response = await this.fetchImpl(url, { method: 'PUT', headers, body });
    if (!response.ok) {
      throw new Error(
        `Storage PUT failed: ${response.status} ${await response.text().catch(() => '')}`,
      );
    }
    return { key, sizeBytes: body.byteLength, sha256: payloadHash };
  }

  async get(bucket: 'originals' | 'artifacts', key: string) {
    const url = this.urlFor(bucket, key);
    const headers = await signRequest({
      method: 'GET',
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payloadHash: EMPTY_SHA256,
    });
    const response = await this.fetchImpl(url, { headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Storage GET failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(bucket: 'originals' | 'artifacts', key: string) {
    const url = this.urlFor(bucket, key);
    const headers = await signRequest({
      method: 'DELETE',
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payloadHash: EMPTY_SHA256,
    });
    const response = await this.fetchImpl(url, { method: 'DELETE', headers });
    return response.ok || response.status === 404;
  }

  async exists(bucket: 'originals' | 'artifacts', key: string) {
    const url = this.urlFor(bucket, key);
    const headers = await signRequest({
      method: 'HEAD',
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payloadHash: EMPTY_SHA256,
    });
    const response = await this.fetchImpl(url, { method: 'HEAD', headers });
    return response.ok;
  }

  async signedDownloadUrl(
    bucket: 'originals' | 'artifacts',
    key: string,
    fileName: string,
    ttlSeconds: number,
  ): Promise<SignedUrl> {
    const url = this.urlFor(bucket, key);
    url.searchParams.set(
      'response-content-disposition',
      `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
    );
    const presigned = await presignUrl({
      method: 'GET',
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresIn: ttlSeconds,
    });
    return { url: presigned, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  /** Presigned S3 URLs verify themselves at the origin; nothing to check locally. */
  async verifySignature(): Promise<boolean> {
    return true;
  }

  async health() {
    try {
      const url = new URL(
        `${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucketOriginals}`,
      );
      const headers = await signRequest({
        method: 'HEAD',
        url,
        region: this.config.region,
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        payloadHash: EMPTY_SHA256,
      });
      const response = await this.fetchImpl(url, { method: 'HEAD', headers });
      return { ok: response.ok, detail: response.ok ? null : `status ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
    }
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

interface SignParams {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  extraHeaders?: Record<string, string>;
}

/** AWS SigV4 for header-based auth, implemented on WebCrypto for Workers compatibility. */
async function signRequest(params: SignParams): Promise<Record<string, string>> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: params.url.host,
    'x-amz-content-sha256': params.payloadHash,
    'x-amz-date': amzDate,
    ...(params.extraHeaders ?? {}),
  };

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]?.trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    params.method,
    params.url.pathname,
    canonicalQuery(params.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await hexSha256(canonicalRequest)].join(
    '\n',
  );

  const signature = await deriveSignature(
    params.secretAccessKey,
    dateStamp,
    params.region,
    stringToSign,
  );

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function presignUrl(params: {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresIn: number;
}): Promise<string> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${params.region}/s3/aws4_request`;

  const url = new URL(params.url.toString());
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${params.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(params.expiresIn));
  url.searchParams.set('X-Amz-SignedHeaders', 'host');

  const canonicalRequest = [
    params.method,
    url.pathname,
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await hexSha256(canonicalRequest)].join(
    '\n',
  );
  const signature = await deriveSignature(
    params.secretAccessKey,
    dateStamp,
    params.region,
    stringToSign,
  );
  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

function canonicalQuery(searchParams: URLSearchParams): string {
  return [...searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hexSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input) as ArrayBufferView,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacRaw(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as ArrayBufferView,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      new TextEncoder().encode(message) as ArrayBufferView,
    ),
  );
}

async function deriveSignature(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  stringToSign: string,
): Promise<string> {
  const kDate = await hmacRaw(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, 's3');
  const kSigning = await hmacRaw(kService, 'aws4_request');
  const signature = await hmacRaw(kSigning, stringToSign);
  return [...signature].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Storage keys embed the tenant, so a mis-scoped read is visible in the key itself. */
export function buildStorageKey(parts: {
  organizationId: string;
  workspaceId: string;
  kind: 'source' | 'artifact' | 'upload';
  id: string;
  fileName: string;
}): string {
  // Take the basename first: a client-supplied "../../etc/passwd" must not contribute
  // path separators, and the surviving dot runs are collapsed so no segment can ever be
  // `..` once the key is joined.
  const basename = parts.fileName.split(/[\\/]/).pop() ?? '';
  const safeName =
    basename
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .slice(-120)
      .replace(/^[._-]+/, '') || 'file';
  return `${parts.organizationId}/${parts.workspaceId}/${parts.kind}/${parts.id}/${safeName}`;
}
