-- 006_visit_from_type — "visiting from" becomes a category plus a detail.
--
-- from_type is the category (Company / Private / Government Entity); from_detail
-- names the specific company or entity. The old free-text `company` column (added
-- five days ago, no real data yet) becomes from_detail so nothing is orphaned.
--
-- Wrapped in a guard so the file is safe to re-run and safe whatever partial
-- state a box is in.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'visits' AND column_name = 'company'
  ) THEN
    ALTER TABLE visits RENAME COLUMN company TO from_detail;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'visits' AND column_name = 'from_detail'
  ) THEN
    ALTER TABLE visits ADD COLUMN from_detail TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'visits' AND column_name = 'from_type'
  ) THEN
    ALTER TABLE visits ADD COLUMN from_type TEXT
      CHECK (from_type IN ('COMPANY', 'PRIVATE', 'GOVERNMENT'));
  END IF;
END $$;
