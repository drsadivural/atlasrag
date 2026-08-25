-- Extensions the schema depends on. Run once, at cluster initialisation.
--
-- `vector` provides the embedding column type and the HNSW index used for semantic
-- retrieval. `pg_trgm` backs the fuzzy title search in the knowledge base.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The integration suite runs against its own database so a migration can never touch
-- development data.
SELECT 'CREATE DATABASE uxe_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'uxe_test')\gexec

\connect uxe_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
