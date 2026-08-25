-- 0003: separate quotable text from search context.
--
-- Citation verification re-checks an excerpt verbatim against the stored page text. That
-- only works if `source_chunks.content` contains nothing synthetic, so the parent heading
-- path moves out of `content` into its own column and is folded back in at index time.
--
-- `source_sections.body` is added so requirement extraction reads the obligation wording
-- directly instead of reassembling it from derived chunks.
--
-- Expand phase: both columns are nullable-with-default, so the previous application
-- version keeps working against this schema during a rolling deploy.

ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS heading_text text NOT NULL DEFAULT '';
ALTER TABLE source_sections ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '';

-- Replace the FTS index so it covers heading context as well as the verbatim body. The
-- lexical query uses this exact expression, which is what keeps it index-backed.
DROP INDEX IF EXISTS source_chunks_fts_idx;
CREATE INDEX source_chunks_fts_idx
  ON source_chunks
  USING gin (to_tsvector('english', coalesce(heading_text, '') || ' ' || content));

-- Requirement extraction scans obligation sections; this keeps that scan index-backed.
CREATE INDEX IF NOT EXISTS source_sections_requirement_body_idx
  ON source_sections (source_version_id, ordinal)
  WHERE is_requirement;
