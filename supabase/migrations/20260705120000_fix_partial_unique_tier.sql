-- Drop unconditional unique constraint so revoked rows don't block re-issue
ALTER TABLE public.user_entitlements DROP CONSTRAINT IF EXISTS user_entitlements_user_id_tier_key;

-- Replace with partial unique index: only one active entitlement per user+tier
-- Revoked entitlements can coexist freely, preserving the history
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entitlements_active_tier
  ON public.user_entitlements(user_id, tier)
  WHERE revoked_at IS NULL;

COMMENT ON INDEX idx_user_entitlements_active_tier IS 'Enforces one active entitlement per user+tier; revoked rows are excluded';
