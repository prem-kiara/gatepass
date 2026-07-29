-- 008_webauthn — passkeys (Face ID / fingerprint) for admins.
--
-- One row per registered device. The credential is a public key; the private
-- key and the biometric never leave the user's phone, so there is no secret
-- here to leak — losing this table cannot expose anyone's face or fingerprint.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  credential_id  TEXT UNIQUE NOT NULL,     -- base64url, the authenticator's id
  public_key     BYTEA NOT NULL,           -- COSE public key
  counter        BIGINT NOT NULL DEFAULT 0,-- signature counter, clone detection
  transports     TEXT,                     -- JSON array: ['internal'], ['hybrid'] ...
  device_label   TEXT,                     -- human name, e.g. "iPhone (Face ID)"
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS webauthn_user_idx ON webauthn_credentials(user_id);
