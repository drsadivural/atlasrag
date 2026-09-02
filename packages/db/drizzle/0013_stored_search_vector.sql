-- Compute the search vector once, at index time, instead of on every row of every query.
--
-- The lexical channel matched on `to_tsvector(heading_text || content)` and ranked on it,
-- an expression the GIN index could satisfy for the match but not for the ranking — so
-- every matched row had its tsvector rebuilt to be scored. On the indexed 1,348-page code
-- a broad query matches ~17,500 chunks, and that rebuild cost 465ms of a single search.
--
-- A stored generated column removes the work rather than trading it: the vector is built
-- when the chunk is written, the GIN index covers the column directly, and ranking reads
-- what is already there. The definition is character-for-character the expression the old
-- index used, so nothing about what matches changes — only when it is computed.

ALTER TABLE source_chunks
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(heading_text, '') || ' ' || content)
  ) STORED;

CREATE INDEX source_chunks_search_vector_idx ON source_chunks USING gin (search_vector);

-- The expression index is now dead weight: same contents, larger, and never chosen.
DROP INDEX IF EXISTS source_chunks_fts_idx;
