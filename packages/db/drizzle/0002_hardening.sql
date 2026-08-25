-- 0002: constraints and guarantees that the ORM schema cannot express.
--
-- Everything here is additive (expand phase). Nothing is dropped or renamed, so a rolling
-- deploy can run the previous application version against this schema safely.

-- ---------------------------------------------------------------------------
-- Audit trail is append-only.
-- Enforced by a trigger rather than only by convention, so a future code path (or a
-- direct psql session using the application role) cannot quietly rewrite history.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uxe_audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION uxe_audit_events_immutable();

-- ---------------------------------------------------------------------------
-- Exactly one current version per source.
-- Without this a race between two concurrent promotions could leave a source citing two
-- versions at once, which would make historical evidence ambiguous.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS source_versions_one_current
  ON source_versions (source_id)
  WHERE is_current;

-- A version may only be marked current after it has been promoted (i.e. validated).
ALTER TABLE source_versions
  DROP CONSTRAINT IF EXISTS source_versions_current_requires_promotion;
ALTER TABLE source_versions
  ADD CONSTRAINT source_versions_current_requires_promotion
  CHECK (NOT is_current OR promoted_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Citation integrity.
-- A verified citation must carry a non-empty excerpt; "verified with no evidence" is a
-- state the product must never be able to display.
-- ---------------------------------------------------------------------------
ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_verified_requires_excerpt;
ALTER TABLE citations
  ADD CONSTRAINT citations_verified_requires_excerpt
  CHECK (NOT verified OR length(btrim(supporting_excerpt)) > 0);

ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_verification_method_valid;
ALTER TABLE citations
  ADD CONSTRAINT citations_verification_method_valid
  CHECK (verification_method IN ('exact', 'normalized', 'failed'));

-- A failed verification can never be flagged verified.
ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_failed_not_verified;
ALTER TABLE citations
  ADD CONSTRAINT citations_failed_not_verified
  CHECK (verification_method <> 'failed' OR verified = false);

ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_entailment_valid;
ALTER TABLE citations
  ADD CONSTRAINT citations_entailment_valid
  CHECK (entailment IN ('supports', 'contradicts', 'context'));

ALTER TABLE citations DROP CONSTRAINT IF EXISTS citations_scores_in_range;
ALTER TABLE citations
  ADD CONSTRAINT citations_scores_in_range
  CHECK (retrieval_score BETWEEN 0 AND 1 AND rerank_score BETWEEN 0 AND 1);

-- ---------------------------------------------------------------------------
-- Compliance vocabulary is closed. A typo in application code becomes a write error
-- rather than a finding that silently disappears from every dashboard rollup.
-- ---------------------------------------------------------------------------
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_result_valid;
ALTER TABLE findings
  ADD CONSTRAINT findings_result_valid
  CHECK (result IN ('compliant', 'non_compliant', 'needs_evidence', 'not_assessed'));

ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_risk_valid;
ALTER TABLE findings
  ADD CONSTRAINT findings_risk_valid
  CHECK (risk IN ('critical', 'high', 'medium', 'low', 'none'));

ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_confidence_in_range;
ALTER TABLE findings
  ADD CONSTRAINT findings_confidence_in_range
  CHECK (confidence BETWEEN 0 AND 1);

-- A compliant finding must point at evidence. This is the database-level expression of
-- "never report compliance without support".
ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_compliant_requires_evidence;
ALTER TABLE findings
  ADD CONSTRAINT findings_compliant_requires_evidence
  CHECK (
    result <> 'compliant'
    OR jsonb_array_length(project_evidence_citation_ids) > 0
    OR jsonb_array_length(governing_citation_ids) > 0
  );

-- ---------------------------------------------------------------------------
-- Role and membership vocabulary.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_valid;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_valid
  CHECK (role IN ('owner', 'admin', 'consultant', 'knowledge_manager', 'reviewer', 'member', 'read_only'));

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_valid;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_status_valid
  CHECK (status IN ('active', 'invited', 'suspended'));

ALTER TABLE source_permissions DROP CONSTRAINT IF EXISTS source_permissions_scope_valid;
ALTER TABLE source_permissions
  ADD CONSTRAINT source_permissions_scope_valid
  CHECK (
    (scope = 'workspace' AND group_id IS NULL AND user_id IS NULL)
    OR (scope = 'group' AND group_id IS NOT NULL)
    OR (scope = 'users' AND user_id IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Jobs.
-- ---------------------------------------------------------------------------
ALTER TABLE processing_jobs DROP CONSTRAINT IF EXISTS processing_jobs_status_valid;
ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_status_valid
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead_letter'));

ALTER TABLE processing_jobs DROP CONSTRAINT IF EXISTS processing_jobs_percent_in_range;
ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_percent_in_range
  CHECK (percent BETWEEN 0 AND 100);

-- Partial index so the queue poller only scans runnable rows.
CREATE INDEX IF NOT EXISTS processing_jobs_runnable_idx
  ON processing_jobs (priority DESC, created_at ASC)
  WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Correction safety.
-- Only accepted or hand-edited changes may be written into a derivative document; an
-- 'edited' row must actually carry the edit.
-- ---------------------------------------------------------------------------
ALTER TABLE correction_changes DROP CONSTRAINT IF EXISTS correction_changes_status_valid;
ALTER TABLE correction_changes
  ADD CONSTRAINT correction_changes_status_valid
  CHECK (status IN ('proposed', 'accepted', 'rejected', 'edited'));

ALTER TABLE correction_changes DROP CONSTRAINT IF EXISTS correction_changes_edited_has_content;
ALTER TABLE correction_changes
  ADD CONSTRAINT correction_changes_edited_has_content
  CHECK (status <> 'edited' OR edited_content IS NOT NULL);

ALTER TABLE correction_plans DROP CONSTRAINT IF EXISTS correction_plans_strategy_valid;
ALTER TABLE correction_plans
  ADD CONSTRAINT correction_plans_strategy_valid
  CHECK (output_strategy IN ('in_place_text', 'tracked_changes', 'overlay', 'ocr_rebuild', 'revised_edition'));

-- ---------------------------------------------------------------------------
-- Retrieval and search performance.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sources_title_ilike_idx ON sources USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS consultations_title_ilike_idx ON consultations USING gin (title gin_trgm_ops);

-- Covering index for the per-page lookup performed by the evidence viewer.
CREATE INDEX IF NOT EXISTS source_pages_lookup_idx
  ON source_pages (source_version_id, page_number) INCLUDE (width, height);

-- ---------------------------------------------------------------------------
-- Housekeeping helpers used by the retention purge job.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sources_deleted_idx ON sources (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS consultations_deleted_idx ON consultations (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS generated_artifacts_retain_idx ON generated_artifacts (retain_until) WHERE retain_until IS NOT NULL;
