-- 011_must_change_password — the password reset lever, matching the PIN one.
--
-- Until now a superadmin resetting a password *typed the new one themselves*,
-- so they knew it indefinitely and nothing forced the user to replace it. That
-- is the same borrow-access pattern the PIN reset was built to avoid: an admin
-- must be able to restore access without being able to use it.
--
-- Set when a one-time password is issued; cleared when the user picks their own.
-- Enforced in requireAuth, so a session holding a temporary password can do
-- nothing but replace it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
