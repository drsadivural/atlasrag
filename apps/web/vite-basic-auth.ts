import { timingSafeEqual } from 'node:crypto';
import type { Connect, Plugin } from 'vite';

/**
 * HTTP basic authentication for the preview server.
 *
 * A stopgap while Cloudflare Access is not yet in place: the staging hostname is on the
 * public internet and its demo account is documented, so the door needs a lock of some
 * kind. Basic auth over the tunnel's TLS is a weak lock, but a present one, and it comes
 * out in a single line the moment Access takes over.
 *
 * It applies only to requests whose Host is one of the public names, so the loopback
 * address the verification suites use is unaffected — and only a process already on the
 * machine can reach that, since both the web server and the API bind to 127.0.0.1.
 */
export function basicAuth(options: { credentials: string; hosts: string[] }): Plugin | null {
  const separator = options.credentials.indexOf(':');
  if (separator <= 0) return null;

  const expected = Buffer.from(options.credentials);
  const hosts = new Set(options.hosts.map((host) => host.toLowerCase()));

  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    // Host carries the port for a direct request and the bare name through the tunnel;
    // compare on the name alone so both forms resolve the same way.
    const host = (request.headers.host ?? '').toLowerCase().split(':')[0] ?? '';
    if (!hosts.has(host)) {
      next();
      return;
    }

    const header = request.headers.authorization ?? '';
    if (header.startsWith('Basic ')) {
      const supplied = Buffer.from(header.slice(6), 'base64');
      // Length is compared first because timingSafeEqual throws on a mismatch, and the
      // length of a credential is not the secret.
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
        next();
        return;
      }
    }

    response.statusCode = 401;
    response.setHeader('WWW-Authenticate', 'Basic realm="UXE Consulting AI (staging)"');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    // No cache anywhere: a proxy holding on to a 401, or to the page behind it, would
    // make the lock look broken in one direction or absent in the other.
    response.setHeader('cache-control', 'no-store');
    response.end('Sign in is required to reach this staging environment.\n');
  };

  return {
    name: 'uxe:basic-auth',
    // In the hook body rather than in a returned post hook, so this runs before the
    // internal middlewares — including the /api proxy, which must not be reachable
    // without the same credentials.
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
