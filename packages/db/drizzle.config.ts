import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://uxe:uxe_dev_password@127.0.0.1:55432/uxe_dev',
  },
  strict: true,
  verbose: true,
});
