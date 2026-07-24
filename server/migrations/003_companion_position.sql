-- 003_companion_position — give companions an explicit order.
--
-- Companions are inserted together in one transaction, so their created_at values
-- tie and any ORDER BY created_at falls back to the random UUID id. That made the
-- order the guard entered them unrecoverable, showing members in arbitrary order
-- in the console and numbering them arbitrarily in SharePoint filenames.

ALTER TABLE visit_companions ADD COLUMN IF NOT EXISTS position INT;

-- Existing rows get a stable (if arbitrary) order so the column can be NOT NULL.
UPDATE visit_companions vc
SET position = sub.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY visit_id ORDER BY created_at, id) AS rn
  FROM visit_companions
) sub
WHERE vc.id = sub.id AND vc.position IS NULL;

ALTER TABLE visit_companions ALTER COLUMN position SET DEFAULT 1;
ALTER TABLE visit_companions ALTER COLUMN position SET NOT NULL;

CREATE INDEX IF NOT EXISTS companions_visit_position_idx ON visit_companions(visit_id, position);
