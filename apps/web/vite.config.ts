import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basicAuth } from './vite-basic-auth.js';

/**
 * Vite configuration.
 *
 * The dev server proxies `/api` to the API process so the browser sees a single origin.
 * That keeps the session cookie first-party in development exactly as it is in production,
 * where Cloudflare routes both under one hostname — otherwise SameSite behaviour would
 * differ between environments and only break on deploy.
 */
const apiTarget = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:8787';

/**
 * Hostnames this server will answer to, beyond localhost.
 *
 * Vite rejects requests whose Host header it does not recognise, which is the right
 * default — it stops a DNS rebinding attack from reaching a local server. Running behind
 * a reverse proxy or a tunnel means the Host is the public hostname, so that name has to
 * be named explicitly rather than by turning the check off.
 */
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

/**
 * `user:password`, and only for the public hostnames above.
 *
 * A stopgap lock on a staging environment that is reachable from the internet. Unset in
 * development, where the server answers on loopback only.
 */
const basicAuthPlugin = process.env.WEB_BASIC_AUTH
  ? basicAuth({ credentials: process.env.WEB_BASIC_AUTH, hosts: allowedHosts })
  : null;

/**
 * Proxy shared by `vite dev` and `vite preview`.
 *
 * Both must present a single origin, because the session cookie is same-origin: a preview
 * build that talked to the API cross-origin would behave differently from production and
 * only fail after deploy.
 */
/**
 * Stops a browser holding yesterday's `index.html`.
 *
 * Route chunks carry a content hash and are replaced on every deploy. A browser that keeps
 * the entry document then asks for a chunk filename that no longer exists, and the
 * application fails to navigate with "Failed to fetch dynamically imported module" on a
 * deployment that is working perfectly well.
 *
 * The hashed assets are immutable and cached for a year — the whole point of hashing them.
 * The document that names them must never be, so a reload always learns the current set.
 */
type CacheMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

const entryDocumentCachePlugin = {
  name: 'uxe-entry-document-cache',
  configurePreviewServer(server: { middlewares: { use: (fn: CacheMiddleware) => void } }) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path.startsWith('/assets/') && /\.[0-9a-zA-Z_-]{8,}\.(js|css)$/.test(path)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      } else if (path === '/' || path.endsWith('.html') || !path.includes('.')) {
        // The document, and every client-routed path that resolves to it.
        res.setHeader('cache-control', 'no-cache');
      }
      next();
    });
  },
};

const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: apiTarget,
    changeOrigin: false,
    // SSE must not be buffered, or job progress would arrive in one lump at the end.
    configure: (proxy) => {
      proxy.on('proxyRes', (proxyRes) => {
        if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
          proxyRes.headers['cache-control'] = 'no-cache, no-transform';
        }
      });
    },
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [
    ...(basicAuthPlugin ? [basicAuthPlugin] : []),
    entryDocumentCachePlugin,
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The assets package sits outside the app root and is served from /assets.
      '@assets': fileURLToPath(new URL('../../assets', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: apiProxy,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: apiProxy,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  },
  build: {
    target: 'es2022',
    sourcemap: mode !== 'production',
    // Long consultations and the evidence viewer are lazily loaded, so a large main
    // chunk would defeat the point; this keeps the budget honest.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Split the framework out of the app chunk so a code change does not invalidate
         * the cached copy of React on every deploy.
         */
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return 'react';
          }
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('@radix-ui')) return 'radix';
          return undefined;
        },
      },
    },
  },
  publicDir: 'public',
}));
