-- A removed consultation is an archived one.
--
-- `softDelete` used to stamp `deleted_at` and leave `status` untouched, so a consultation
-- removed while it was `action_required` stayed `action_required` for good. Nothing reads
-- it directly — every consultation query filters `deleted_at` — but the compliance reviews
-- hanging off it did, and kept raising attention items whose own links answered
-- "Consultation not found".
--
-- The repository now moves both together. This brings the rows already in the table into
-- line so the two never disagree again.

UPDATE consultations
   SET status = 'archived'
 WHERE deleted_at IS NOT NULL
   AND status <> 'archived';
