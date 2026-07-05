-- Drop the unconditional unique constraint that blocks re-redeeming a tier after revocation
ALTER TABLE public.user_entitlements DROP CONSTRAINT IF EXISTS user_entitlements_user_id_tier_key;

-- Drop the old non-unique partial index (replaced by the unique one below)
DROP INDEX IF EXISTS idx_user_entitlements_tier;

-- Create a partial unique index that only applies to ACTIVE (non-revoked) entitlements
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_entitlements_active_tier
  ON public.user_entitlements(user_id, tier)
  WHERE revoked_at IS NULL;
