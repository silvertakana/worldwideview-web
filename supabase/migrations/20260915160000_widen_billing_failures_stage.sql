-- =============================================================================
-- Widen the billing_failures stage CHECK to admit 'resolve'.
-- =============================================================================
-- WHY
--   20260915120003_create_billing_failures.sql allowed ('provision','tier_sync'),
--   i.e. the two stages that happen AFTER an event has been attributed to a
--   customer. There is a third kind of unfinished work that happens BEFORE that:
--   an event with no usable customer email anywhere, neither on the payload nor
--   on the Stripe customer. It needs a different operator response (fix the
--   account link or the missing address, not re-drive a globe call), so it must
--   not be filed under 'provision'.
--
--   `stage` is NOT NULL, so without this the handler's only options for that
--   event were to lie about which stage failed or to lose the record entirely.
--   The webhook now writes stage = 'resolve' for exactly that case.
--
-- SAFETY
--   Additive: every existing value stays valid, so no row changes and no
--   existing reader is affected. DROP + ADD is the only way to change a CHECK
--   constraint's expression; a plain ADD would leave both constraints in force.
--
--   Not applied by the commit that adds it. Apply manually via the SQL Editor,
--   before the handler is deployed - a database that rejects 'resolve' turns a
--   recorded failure back into a log line, which is the state this exists to end.
-- =============================================================================

ALTER TABLE public.billing_failures
    DROP CONSTRAINT IF EXISTS billing_failures_stage_check;

ALTER TABLE public.billing_failures
    ADD CONSTRAINT billing_failures_stage_check
    CHECK (stage IN ('provision', 'tier_sync', 'resolve'));
