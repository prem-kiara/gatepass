-- 005_visit_company — capture which company/organisation the visitor is from.
--
-- Per-visit rather than per-visitor: the same person may visit representing a
-- different company on different days, so this belongs on the visit. The
-- repeat-visitor prefill pre-fills the last known value rather than fixing it.

ALTER TABLE visits ADD COLUMN IF NOT EXISTS company TEXT;
