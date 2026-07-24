-- 002_photo_sync — records which photos have been copied to SharePoint.
--
-- Existence of a row means "already uploaded", which is what makes the sync
-- safe to run every few minutes: it only ever picks up photos with no row here.

CREATE TABLE IF NOT EXISTS photo_sync (
  photo_path  TEXT PRIMARY KEY,             -- the UUID filename on disk
  visit_id    UUID NOT NULL REFERENCES visits(id),
  remote_path TEXT NOT NULL,                -- full path inside the SharePoint drive
  remote_url  TEXT,                         -- webUrl Graph returned, for the audit trail
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS photo_sync_visit_idx       ON photo_sync(visit_id);
CREATE INDEX IF NOT EXISTS photo_sync_uploaded_at_idx ON photo_sync(uploaded_at DESC);
