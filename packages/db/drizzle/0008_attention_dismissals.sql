-- Items on the dashboard somebody has said they have dealt with.
--
-- Most things in "Needs attention" have a fix the product can carry out: a failed job is
-- retried, a stale source is re-indexed, a finished report is marked as read. Two do not.
-- A non-compliant finding and a requirement short of evidence are statements about a real
-- building, and no button on a dashboard makes either untrue — the only honest thing a
-- person can do from here is say they have seen it and it is being handled.
--
-- So this records an acknowledgement rather than a resolution. The finding stays exactly
-- where it is, in the review, with its evidence; it simply stops being raised again on a
-- screen that is meant to show what nobody has looked at yet. Who dismissed it and when is
-- kept, because "somebody decided this was fine" is a decision worth being able to trace.
CREATE TABLE IF NOT EXISTS attention_dismissals (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  item_id       text NOT NULL,
  dismissed_by  text NOT NULL REFERENCES users (id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS attention_dismissals_key
  ON attention_dismissals (workspace_id, kind, item_id);
