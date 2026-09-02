-- A report is named after the document it reviews.
--
-- Reports used to be named after the consultation they were asked from, and every
-- consultation is called "New consultation" until somebody renames it — so a Reports page
-- held six rows reading "New consultation - compliance report" and nothing said which
-- drawing any of them covered. New reports are named from the drawing by the job that
-- makes them; this gives the same name to the ones already made.
--
-- Only rows still carrying the old generated name are touched: a report somebody titled
-- by hand, or whose consultation was renamed after the fact, is left as it is. The name
-- is also the download's file name, so it is one token.

CREATE TEMP TABLE renamed_reports ON COMMIT DROP AS
SELECT
  a.id AS artifact_id,
  (
    CASE
      WHEN length(regexp_replace(string_agg(s.title, '+' ORDER BY cs.created_at), '\s+', '_', 'g')) > 120
        THEN left(regexp_replace(string_agg(s.title, '+' ORDER BY cs.created_at), '\s+', '_', 'g'), 117) || '...'
      ELSE regexp_replace(string_agg(s.title, '+' ORDER BY cs.created_at), '\s+', '_', 'g')
    END
  ) || '_' || CASE a.kind
    WHEN 'compliance_report' THEN 'Compliance_report'
    WHEN 'summary' THEN 'Summary'
    WHEN 'evidence_matrix' THEN 'Evidence_matrix'
  END AS title
FROM generated_artifacts a
JOIN consultations c ON c.id = a.consultation_id
JOIN consultation_sources cs ON cs.consultation_id = c.id AND cs.role = 'project'
JOIN sources s ON s.id = cs.source_id
WHERE a.kind IN ('compliance_report', 'summary', 'evidence_matrix')
  AND a.title = c.title || ' - ' || replace(a.kind, '_', ' ')
GROUP BY a.id, a.kind;

UPDATE generated_artifacts a
   SET title = r.title
  FROM renamed_reports r
 WHERE a.id = r.artifact_id;

UPDATE reports p
   SET title = r.title
  FROM renamed_reports r
 WHERE p.artifact_id = r.artifact_id;
