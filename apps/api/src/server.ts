// Node-only: loads .env before configuration is validated. The Workers build uses its
// own entry point and receives configuration through bindings instead.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { startWorkerLoop } from './jobs/loop.js';

/**
 * Node entry point.
 *
 * The same Hono app is exported for the Workers build; this file only adds the Node HTTP
 * adapter and, in single-process deployments, the in-process job loop.
 */
const { app, deps } = buildApp();

const stopWorker = startWorkerLoop(deps);

const server = serve(
  { fetch: app.fetch, port: deps.env.API_PORT, hostname: deps.env.API_HOST },
  (info) => {
    deps.logger.info('api.listening', {
      port: info.port,
      host: deps.env.API_HOST,
      env: deps.env.APP_ENV,
      storage: deps.services.storage.id,
      chatProvider: deps.services.chat.id,
      embeddingProvider: deps.services.embeddings.id,
    });
  },
);

const shutdown = (signal: string) => {
  deps.logger.info('api.shutdown', { signal });
  stopWorker();
  server.close(() => {
    // Exit only once in-flight requests have drained.
    process.exit(0);
  });
  // Hard cap so a stuck connection cannot block a deploy indefinitely.
  setTimeout(() => process.exit(0), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
