-- The last four characters of a stored provider key.
--
-- The credential itself has no read path by design, which left the Models list unable to
-- say anything about a saved key beyond that one exists — so somebody holding two keys for
-- one provider could not tell which had been saved, and nobody could confirm they had
-- pasted the key they meant. Four trailing characters identify a key to the person who
-- owns it and are useless to anybody else; every provider prints them this way.
ALTER TABLE model_configurations ADD COLUMN IF NOT EXISTS credential_last4 text;
