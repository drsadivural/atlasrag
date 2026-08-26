import { describe, expect, it } from 'vitest';
import type { Connect } from 'vite';
import { basicAuth } from '../../apps/web/vite-basic-auth.js';

/**
 * The stopgap lock in front of the staging hostname.
 *
 * Worth testing rather than trusting to a live check, because two of its properties are
 * easy to break without noticing: that it covers the API and not only the pages, and that
 * it leaves the loopback address alone so the verification suites can still run.
 */

const HOSTS = ['consultnow.ayonix.com'];
const CREDENTIALS = 'uxe:correct-horse';
const HEADER = `Basic ${Buffer.from(CREDENTIALS).toString('base64')}`;

interface Result {
  status: number;
  headers: Record<string, string>;
  body: string;
  passedThrough: boolean;
}

function request(host: string, authorization?: string): Result {
  const plugin = basicAuth({ credentials: CREDENTIALS, hosts: HOSTS });
  if (!plugin) throw new Error('plugin was not created');

  let middleware: Connect.NextHandleFunction | undefined;
  const configure = plugin.configurePreviewServer as (server: {
    middlewares: { use: (fn: Connect.NextHandleFunction) => void };
  }) => void;
  configure({ middlewares: { use: (fn) => (middleware = fn) } });
  if (!middleware) throw new Error('no middleware was registered');

  const result: Result = { status: 200, headers: {}, body: '', passedThrough: false };
  const response = {
    set statusCode(value: number) {
      result.status = value;
    },
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string) {
      result.body = chunk ?? '';
    },
  };

  middleware(
    { headers: { host, ...(authorization ? { authorization } : {}) } } as never,
    response as never,
    () => {
      result.passedThrough = true;
    },
  );
  return result;
}

describe('staging basic auth', () => {
  it('challenges an unauthenticated request to the public hostname', () => {
    const result = request('consultnow.ayonix.com');
    expect(result.passedThrough).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers['www-authenticate']).toContain('Basic realm=');
    // A cached 401, or a cached page behind it, makes the lock look broken or absent.
    expect(result.headers['cache-control']).toBe('no-store');
  });

  it('lets the right credential through', () => {
    expect(request('consultnow.ayonix.com', HEADER).passedThrough).toBe(true);
  });

  it('rejects a wrong password and a malformed header alike', () => {
    const wrong = `Basic ${Buffer.from('uxe:wrong').toString('base64')}`;
    expect(request('consultnow.ayonix.com', wrong).passedThrough).toBe(false);
    expect(request('consultnow.ayonix.com', 'Bearer something').passedThrough).toBe(false);
    expect(request('consultnow.ayonix.com', 'Basic').passedThrough).toBe(false);
  });

  it('leaves loopback alone, so the verification suites still have a way in', () => {
    expect(request('127.0.0.1:4173').passedThrough).toBe(true);
    expect(request('localhost:4173').passedThrough).toBe(true);
  });

  it('ignores the port when matching the public hostname', () => {
    expect(request('consultnow.ayonix.com:443').passedThrough).toBe(false);
  });

  it('refuses to install itself with credentials that carry no password', () => {
    expect(basicAuth({ credentials: 'nopassword', hosts: HOSTS })).toBeNull();
    expect(basicAuth({ credentials: ':secret', hosts: HOSTS })).toBeNull();
  });
});
