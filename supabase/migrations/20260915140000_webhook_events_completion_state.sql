-- Webhook event completion state (D1).
--
-- 20260806000001 created webhook_events with
--   processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- so every claim was written already looking processed. The handler claimed the
-- event BEFORE doing any work and swallowed any mid-handler failure into an
-- HTTP 200, so Stripe never retried while every replay short-circuited on the
-- claim as a duplicate: a customer could pay and receive nothing, invisibly.
--
-- After this migration a row encodes two distinct states:
--   processed_at IS NULL     -> claimed, never completed. Safe to reprocess.
--   processed_at IS NOT NULL -> completed. Only this short-circuits a replay.
--
-- Apply this migration BEFORE deploying the matching handler change: while the
-- DEFAULT and NOT NULL are still in place, the claim insert of a NULL
-- processed_at fails and the ledger degrades to "always process" (at-least-once,
-- no dedupe) rather than to silent loss.
ALTER TABLE webhook_events
    ALTER COLUMN processed_at DROP DEFAULT,
    ALTER COLUMN processed_at DROP NOT NULL;

-- Operational detail for the unfinished rows a reconciler will query. Both
-- columns are written by one atomic statement in
-- src/lib/billing/webhook-idempotency.ts (no read-modify-write), which is why no
-- attempt counter is kept: incrementing one would need either a non-atomic
-- read-then-write or a dedicated RPC. `last_attempt_at` is what lets a
-- reconciler tell "Stripe is still retrying" from "abandoned", which an attempt
-- count alone cannot.
ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

COMMENT ON COLUMN webhook_events.processed_at IS
    'NULL = claimed but never completed (a redelivery may reprocess); non-null = completed.';
COMMENT ON COLUMN webhook_events.last_error IS
    'Most recent handler failure for an unfinished event.';
COMMENT ON COLUMN webhook_events.last_attempt_at IS
    'When the handler last failed for an unfinished event.';

-- Reconciler / operator query: unfinished events awaiting a Stripe redelivery.
CREATE INDEX IF NOT EXISTS webhook_events_unfinished_idx
    ON webhook_events (last_attempt_at)
    WHERE processed_at IS NULL;
