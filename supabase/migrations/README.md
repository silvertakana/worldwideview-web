# Migrations

Run the SQL files in order in the Supabase SQL Editor (Dashboard > SQL Editor) or via `psql`:

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/001_access_codes.sql
```

## Setting an admin user

Run this in Supabase SQL Editor (replace the email):

```sql
UPDATE auth.users
SET raw_app_meta_data = jsonb_set(COALESCE(raw_app_meta_data, '{}'), '{role}', '"admin"')
WHERE email = 'your-email@example.com';
```

The change takes effect on the user's next sign-in. The existing session cookie still reflects the old metadata until the user re-authenticates.
