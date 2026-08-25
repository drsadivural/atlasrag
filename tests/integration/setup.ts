import 'dotenv/config';

/**
 * Integration-suite bootstrap.
 *
 * Points every test at the dedicated test database and fails loudly rather than silently
 * running against the development one, which a stray migration would then destroy.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests refuse to run against DATABASE_URL, ' +
      'because they truncate every table between cases.',
  );
}

if (url === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be a different database from DATABASE_URL.');
}

process.env.DATABASE_URL = url;
process.env.APP_ENV = 'development';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
