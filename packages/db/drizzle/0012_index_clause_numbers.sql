-- Put the clause number back into the text that retrieval searches.
--
-- Structure detection lifts "6.4.2" out of the heading into its own column, and the body
-- below a heading does not repeat it. Measured across the indexed 1,348-page code: of the
-- 10,215 chunks carrying a clause number, the number appeared in the indexed text of 90 and
-- in the heading text of none. Asking for "clause 2.7.1" searched text that contained no
-- such string, so the right passage was never a candidate — a clause-number lookup found
-- its own clause 0% of the time at rank 1.
--
-- The chunker now prefixes the identifier onto `heading_text`, which is folded into both
-- the search vector and the embedding input and is never quoted as source text. This does
-- the same for chunks already indexed, so a corpus does not have to be re-ingested to
-- become findable by clause. The GIN index is on the expression over `heading_text`, so it
-- follows the update.
--
-- Idempotent by construction: a row whose heading already begins with its identifier is
-- left alone.

UPDATE source_chunks
   SET heading_text = btrim(
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
                THEN NULLIF(btrim(coalesce(chapter, '')), '') END,
           heading_text
         )
       )
 WHERE (
         NULLIF(btrim(coalesce(clause, '')), '') IS NOT NULL
      OR NULLIF(btrim(coalesce(section, '')), '') IS NOT NULL
      OR NULLIF(btrim(coalesce(chapter, '')), '') IS NOT NULL
       )
   AND heading_text NOT LIKE
       coalesce(NULLIF(btrim(coalesce(clause, '')), ''),
                NULLIF(btrim(coalesce(section, '')), ''),
                btrim(coalesce(chapter, ''))) || '%';
