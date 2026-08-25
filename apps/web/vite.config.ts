import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

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
 * Proxy shared by `vite dev` and `vite preview`.
 *
 * Both must present a single origin, because the session cookie is same-origin: a preview
 * build that talked to the API cross-origin would behave differently from production and
 * only fail after deploy.
 */
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
  plugins: [react(), tailwindcss()],
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
  },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
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
