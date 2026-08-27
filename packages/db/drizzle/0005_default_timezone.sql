-- Gulf Standard Time as the default for new workspaces.
--
-- The entities this is built for are in the UAE; a workspace formatting every report date
-- and audit line in UTC is four hours wrong on everything somebody checks. Existing rows
-- are left exactly as they are — a workspace elsewhere that deliberately chose UTC keeps
-- it, and nobody's dates move underneath them.
ALTER TABLE workspaces ALTER COLUMN timezone SET DEFAULT 'Asia/Dubai';
