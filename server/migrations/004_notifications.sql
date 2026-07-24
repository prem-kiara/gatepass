-- 004_notifications — in-app notification history plus Web Push subscriptions.

-- One row per device per user. A guard may use the gate phone and their own;
-- an admin may install the app on a phone and a desktop. All of them get pushed.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  endpoint        TEXT UNIQUE NOT NULL,      -- the push service URL; unique per device
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at TIMESTAMPTZ,
  failure_count   INT NOT NULL DEFAULT 0,
  -- Set when the push service reports the subscription is permanently gone
  -- (404/410). Kept rather than deleted so we can see a device fell off.
  disabled_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS push_subs_user_idx   ON push_subscriptions(user_id) WHERE disabled_at IS NULL;

-- The durable record. A notification is written here inside the same transaction
-- as the event that caused it, BEFORE any push is attempted — push is a
-- best-effort transport, so if it fails the user still sees this in the app.
CREATE TABLE IF NOT EXISTS notifications (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  type         TEXT NOT NULL,           -- VISIT_PENDING / VISIT_APPROVED / VISIT_REJECTED / VISIT_CHECKED_IN / VISIT_UNATTENDED
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  visit_id     UUID REFERENCES visits(id),
  url          TEXT,                    -- where tapping it should land
  data         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at      TIMESTAMPTZ,
  -- Delivery bookkeeping. pushed_at stays NULL when every device failed, which
  -- is what the retry sweeper looks for.
  pushed_at    TIMESTAMPTZ,
  push_attempts INT NOT NULL DEFAULT 0,
  -- A broadcast notification to all admins goes stale the moment one of them
  -- decides. Resolving it stops the others being sent to an empty queue.
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_visit_idx ON notifications(visit_id);
-- Partial index driving the retry sweep; stays tiny because most rows are pushed.
CREATE INDEX IF NOT EXISTS notifications_undelivered_idx
  ON notifications(created_at) WHERE pushed_at IS NULL;

-- "Nothing should be lost": rows may be updated (read, resolved, delivery state)
-- but never removed. Same guarantee the visit audit trail has.
CREATE OR REPLACE FUNCTION notifications_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'notifications are permanent; DELETE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_no_delete ON notifications;
CREATE TRIGGER notifications_no_delete
  BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_no_delete();
