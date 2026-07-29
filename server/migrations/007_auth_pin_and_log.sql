-- 007_auth_pin_and_log — PIN sign-in for guards, plus a permanent auth audit log.
--
-- A PIN is an easier credential for a guard on a cheap phone in sunlight, but it
-- must not weaken accountability: it authenticates its owner and no one else, it
-- locks out under brute force, and every use is written to an append-only log so
-- any logged visit can be traced to exactly how the actor proved who they were.

ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_at          TIMESTAMPTZ;
-- Set when a superadmin issues a temporary PIN: the guard must pick a new,
-- private one before they can do anything, so an admin can restore access but
-- cannot leave a working PIN they know.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_pin     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_locked_until    TIMESTAMPTZ;

-- The foulplay ledger. Append-only, exactly like visit_events and notifications.
CREATE TABLE IF NOT EXISTS auth_events (
  id         BIGSERIAL PRIMARY KEY,
  -- The account the event is about (logged into, reset, etc). Nullable so a
  -- failed sign-in against an unknown username can still be recorded.
  user_id    UUID REFERENCES users(id),
  -- Who performed it: the user themselves for a normal sign-in, or the
  -- superadmin for a reset. Lets the log distinguish "you signed in" from
  -- "someone reset your access".
  actor_id   UUID REFERENCES users(id),
  event      TEXT NOT NULL,   -- LOGIN / LOGIN_FAILED / LOGOUT / PIN_SET / PIN_CHANGED /
                              -- PIN_RESET / PIN_LOCKED / PASSWORD_CHANGED /
                              -- WEBAUTHN_REGISTERED / WEBAUTHN_REMOVED
  method     TEXT,            -- PASSWORD / PIN / TEMP_PIN / WEBAUTHN (for sign-in events)
  ip         TEXT,
  user_agent TEXT,
  detail     JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_events_user_idx  ON auth_events(user_id, at DESC);
CREATE INDEX IF NOT EXISTS auth_events_event_idx ON auth_events(event, at DESC);

CREATE OR REPLACE FUNCTION auth_events_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auth_events is append-only; DELETE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS auth_events_no_delete ON auth_events;
CREATE TRIGGER auth_events_no_delete
  BEFORE DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION auth_events_no_delete();
