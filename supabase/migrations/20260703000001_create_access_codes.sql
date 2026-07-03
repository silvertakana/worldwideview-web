CREATE TABLE IF NOT EXISTS access_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    grants_days INT NOT NULL DEFAULT 30,
    max_uses INT NOT NULL DEFAULT 1,
    use_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS user_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code_id UUID REFERENCES access_codes(id),
    source TEXT NOT NULL DEFAULT 'access_code',
    grants_days INT NOT NULL DEFAULT 30,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_for_instance BOOLEAN NOT NULL DEFAULT FALSE,
    instance_created_at TIMESTAMPTZ,
    UNIQUE(user_id, code_id)
);

ALTER TABLE access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_manage_access_codes" ON access_codes
    FOR ALL USING (auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM auth.users WHERE id = auth.uid() AND (raw_app_meta_data->>'role') = 'admin'));

CREATE POLICY "users_read_own_entitlements" ON user_entitlements
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "admins_manage_entitlements" ON user_entitlements
    FOR ALL USING (auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1 FROM auth.users WHERE id = auth.uid() AND (raw_app_meta_data->>'role') = 'admin'));

CREATE INDEX idx_access_codes_code ON access_codes(code);
CREATE INDEX idx_user_entitlements_user_id ON user_entitlements(user_id);
