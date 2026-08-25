-- 0000: extensions and shared helpers.
-- Runs before any table so that vector/trigram types are available to later migrations.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
