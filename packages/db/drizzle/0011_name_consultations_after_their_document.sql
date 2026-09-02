-- A consultation is named after the document sent into it.
--
-- Every consultation is created as "New consultation" and nobody renames it, so the list
-- of past consultations was rows of the same four words — no way to find the one about a
-- particular drawing, which is the only reason anybody opens the list. The repository now
-- names one after the first document attached for review; this does the same for the rows
-- already there.
--
-- Only rows still holding the default name are touched, and only the earliest attachment
-- names them, so a title somebody typed is never overwritten and a consultation does not
-- change name because a second drawing was added to it later.

UPDATE consultations c
   SET title = left(btrim(named.title), 200)
  FROM (
    SELECT DISTINCT ON (cs.consultation_id)
           cs.consultation_id,
           s.title
      FROM consultation_sources cs
      JOIN sources s ON s.id = cs.source_id
     WHERE cs.role = 'project'
     ORDER BY cs.consultation_id, cs.created_at, cs.id
  ) AS named
 WHERE named.consultation_id = c.id
   AND c.title = 'New consultation'
   AND btrim(named.title) <> '';
