-- 009_token_version — lets a credential change invalidate existing sessions.
--
-- Deactivating a user already cuts access instantly (requireAuth re-reads the
-- row on every request), but changing a password, resetting a PIN or removing a
-- passkey did not: a stolen 7-day token kept working. Every issued token now
-- carries the version it was minted at, and any credential change bumps it,
-- so "change my password" actually means "sign everyone else out".

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
