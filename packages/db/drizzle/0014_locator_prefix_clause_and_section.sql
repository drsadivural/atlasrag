-- Narrow the indexed locator prefix to the clause and section.
--
-- Migration 0012 prefixed the clause, section and chapter onto `heading_text` so a clause
-- could be found by number. Measured over the indexed code the three variants are
-- indistinguishable — MRR 0.823 with the chapter, 0.824 without, over 268 queries — so the
-- chapter is dropped on correctness grounds rather than for the metric. A clause number is
-- dotted and specific; a chapter number is a single digit, and it is the identifier heading
-- detection most often invents: "16 CFR 1634", "1 U.S. gal" and "Part 1" all produce a
-- chapter number from text that names no chapter. A wrong identifier in the text a
-- compliance search reads is not worth a gain that is not there.
--
-- Nothing is lost for a chapter lookup: retrieval matches the chapter column directly.
--
-- Rebuilt from `heading_path`, which is the string the prefix was placed in front of and
-- which 0012 did not touch. Chunks with no heading path — a small remainder — have the
-- prefix 0012 wrote removed by name instead, so both branches land on the same definition.

UPDATE source_chunks
   SET heading_text = btrim(
         concat_ws(
           ' ',
           NULLIF(btrim(coalesce(clause, '')), ''),
           CASE WHEN NULLIF(btrim(coalesce(section, '')), '') IS DISTINCT FROM
                     NULLIF(btrim(coalesce(clause, '')), '')
                THEN NULLIF(btrim(coalesce(section, '')), '') END,
           array_to_string(ARRAY(SELECT jsonb_array_elements_text(heading_path)), ' > ')
         )
       )
 WHERE jsonb_array_length(heading_path) > 0;

WITH stripped AS (
  SELECT id,
         btrim(
           substr(
             heading_text,
             length(
               btrim(
                 concat_ws(
                   ' ',
                   NULLIF(btrim(coalesce(clause, '')), ''),
                   CASE WHEN NULLIF(btrim(coalesce(section, '')), '') IS DISTINCT FROM
                             NULLIF(btrim(coalesce(clause, '')), '')
                        THEN NULLIF(btrim(coalesce(section, '')), '') END,
                   CASE WHEN NULLIF(btrim(coalesce(chapter, '')), '') IS DISTINCT FROM
                             NULLIF(btrim(coalesce(clause, '')), '')
                         AND NULLIF(btrim(coalesce(chapter, '')), '') IS DISTINCT FROM
                             NULLIF(btrim(coalesce(section, '')), '')
                        THEN NULLIF(btrim(coalesce(chapter, '')), '') END
                 )
               )
             ) + 1
           )
         ) AS body,
         NULLIF(btrim(coalesce(clause, '')), '') AS cl,
         CASE WHEN NULLIF(btrim(coalesce(section, '')), '') IS DISTINCT FROM
                   NULLIF(btrim(coalesce(clause, '')), '')
              THEN NULLIF(btrim(coalesce(section, '')), '') END AS se
    FROM source_chunks
   WHERE jsonb_array_length(heading_path) = 0
     AND (clause IS NOT NULL OR section IS NOT NULL OR chapter IS NOT NULL)
)
UPDATE source_chunks c
   SET heading_text = btrim(concat_ws(' ', s.cl, s.se, s.body))
  FROM stripped s
 WHERE c.id = s.id;
