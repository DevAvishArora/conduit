-- ════════════════════════════════════════════════════════════════
-- 0007 — Google OAuth account linking
-- ════════════════════════════════════════════════════════════════
-- Lets a user sign in either with email/password OR with their Google
-- account, with both mapping to the same `users` row. The unique index on
-- google_id is partial so existing email/password users (with NULL google_id)
-- don't trip the constraint.
ALTER TABLE users
  ADD COLUMN google_id TEXT,
  -- Track which provider the user most recently authenticated with so the UI
  -- can render a meaningful "signed in via Google" hint.
  ADD COLUMN last_auth_provider TEXT NOT NULL DEFAULT 'password'
    CHECK (last_auth_provider IN ('password', 'google'));

CREATE UNIQUE INDEX idx_users_google_id_uniq ON users (google_id) WHERE google_id IS NOT NULL;

-- Password is nullable now — Google-only users won't have one.
ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL;
