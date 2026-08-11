-- 010_webauthn_soft_delete — removing a passkey disables it, never deletes it.
--
-- The auth log references these devices ("registered a passkey", "removed a
-- passkey"); hard-deleting the row leaves those entries pointing at nothing.
-- Same rule the rest of the system follows for users.

ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- The live-credential lookup is now "not disabled", so index that path.
CREATE INDEX IF NOT EXISTS webauthn_active_idx
  ON webauthn_credentials(user_id) WHERE disabled_at IS NULL;
