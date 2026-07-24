-- 001_init — core schema for GatePass.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('SECURITY', 'ADMIN', 'SUPERADMIN')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visitors (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  TEXT NOT NULL,
  phone      TEXT,                       -- optional; used for repeat-visitor lookup when present
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id       UUID NOT NULL REFERENCES visitors(id),
  photo_path       TEXT NOT NULL,        -- photo of the primary visitor, taken this visit
  purpose          TEXT,
  host_admin_id    UUID REFERENCES users(id),   -- set when visiting an admin
  host_name        TEXT,                        -- free text when visiting non-admin staff
  logged_by        UUID NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'INSIDE', 'CHECKED_OUT')),
  approved_by      UUID REFERENCES users(id),   -- whoever decided: admin or superadmin
  decision_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  checked_in_at    TIMESTAMPTZ,
  checked_out_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A visit is either hosted by an admin or by a named non-admin, never neither.
  CONSTRAINT visits_host_present CHECK (host_admin_id IS NOT NULL OR host_name IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS visit_companions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id   UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  photo_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visit_events (
  id       BIGSERIAL PRIMARY KEY,
  visit_id UUID NOT NULL REFERENCES visits(id),
  actor_id UUID REFERENCES users(id),
  action   TEXT NOT NULL,   -- CREATED / APPROVED / REJECTED / CHECKED_IN / CHECKED_OUT
  detail   JSONB,
  at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visits_status_idx        ON visits(status);
CREATE INDEX IF NOT EXISTS visits_created_at_idx    ON visits(created_at DESC);
CREATE INDEX IF NOT EXISTS visits_approved_by_idx   ON visits(approved_by);
CREATE INDEX IF NOT EXISTS visits_logged_by_idx     ON visits(logged_by);
CREATE INDEX IF NOT EXISTS visitors_phone_idx       ON visitors(phone);
CREATE INDEX IF NOT EXISTS companions_visit_id_idx  ON visit_companions(visit_id);
CREATE INDEX IF NOT EXISTS visit_events_visit_idx   ON visit_events(visit_id, at);

-- The audit trail is the point of the product: make it append-only at the database level
-- so no future code path (or console session) can quietly rewrite who approved what.
CREATE OR REPLACE FUNCTION visit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'visit_events is append-only; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS visit_events_no_update ON visit_events;
CREATE TRIGGER visit_events_no_update
  BEFORE UPDATE OR DELETE ON visit_events
  FOR EACH ROW EXECUTE FUNCTION visit_events_append_only();
