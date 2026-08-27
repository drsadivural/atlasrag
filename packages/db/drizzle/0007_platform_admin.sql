-- Platform administration, which is not a workspace role.
--
-- Every other permission in this system is granted through a membership and is bounded by
-- the workspace that granted it. This one sits above that: it exists so somebody can
-- administer accounts across the deployment — see who exists, change what they can do,
-- reset a password, remove them.
--
-- It deliberately does not carry data access. A platform administrator can act on
-- identities and nothing else; documents, consultations and answers stay behind the tenant
-- checks that every retrieval already makes, because "can administer the accounts" and
-- "may read every customer's confidential filings" are not the same authority and must not
-- be granted by the same flag.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- Finding the administrators is a rare query over a large table; a partial index keeps it
-- from scanning every account.
CREATE INDEX IF NOT EXISTS users_platform_admin_idx ON users (id) WHERE is_platform_admin;
