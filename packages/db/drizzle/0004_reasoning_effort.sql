-- How hard a reasoning model is asked to think before it answers.
--
-- Null means send no such parameter at all, which is what a model without a reasoning
-- mode requires; that is not the same as the provider's own 'none' level. The permitted
-- values are checked in the contract rather than by a constraint here, so a provider
-- adding a level does not need a migration before anyone can use it.
ALTER TABLE model_configurations ADD COLUMN IF NOT EXISTS reasoning_effort text;
