-- 012_approval_means_inside — the gate no longer checks visitors in by hand.
--
-- Approving a visit now marks the visitor inside at the moment of approval, and
-- anyone still inside 24 hours after they went in is marked as left by the
-- sweeper. `checkout_auto` tells those automatic check-outs apart from a guard
-- actually seeing the visitor leave, so the dashboard and the gate can say so.

ALTER TABLE visits ADD COLUMN IF NOT EXISTS checkout_auto BOOLEAN NOT NULL DEFAULT false;

-- Existing approved-but-never-checked-in visits follow the same rule: they went
-- inside when they were approved. Recorded in the audit trail with no actor and
-- marked as a backfill, so nobody reads it as a guard's action. Those already
-- past 24 hours are then closed out by the sweeper on its first run.
WITH moved AS (
  UPDATE visits
     SET status = 'INSIDE',
         checked_in_at = COALESCE(decision_at, created_at)
   WHERE status = 'APPROVED'
  RETURNING id, checked_in_at
)
INSERT INTO visit_events (visit_id, actor_id, action, detail, at)
SELECT id, NULL, 'CHECKED_IN', '{"auto": true, "via": "approval", "backfill": true}'::jsonb, now()
  FROM moved;

CREATE INDEX IF NOT EXISTS visits_inside_idx ON visits(checked_in_at) WHERE status = 'INSIDE';
