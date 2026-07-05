-- Add tier column to access_codes
ALTER TABLE access_codes
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'beta_tester';

COMMENT ON COLUMN access_codes.tier IS 'What this code grants: beta_tester, early_access, pro, enterprise';

-- Add tier column to user_entitlements
ALTER TABLE user_entitlements
  ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'beta_tester';

-- Drop old unique constraint (user_id, code_id)
ALTER TABLE user_entitlements DROP CONSTRAINT IF EXISTS user_entitlements_user_id_code_id_key;

-- Add new unique constraint (user_id, tier) — one tier per user
ALTER TABLE user_entitlements
  ADD CONSTRAINT user_entitlements_user_id_tier_key UNIQUE (user_id, tier);

-- Add per-entitlement revocation (separate from code-level revocation)
ALTER TABLE user_entitlements
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Add index for tier lookups
CREATE INDEX IF NOT EXISTS idx_user_entitlements_tier ON user_entitlements(user_id, tier) WHERE revoked_at IS NULL;
