'use strict';

/**
 * Copies GatePass visitor photos to SharePoint, filed by visit date:
 *
 *   Documents/GatePass/2026-07-24/0930_Suresh-Kumar_a1b2c3d4.jpg
 *   Documents/GatePass/2026-07-24/0930_Suresh-Kumar_a1b2c3d4_member1_Lakshmi.jpg
 *   Documents/GatePass/2026-07-24/_manifest.csv
 *   Documents/GatePass/2026-07-25/...
 *
 * A photo is filed under the date of its **visit**, in gate-local time, not the
 * date the sync happened to run. So a late run, a retry, or a backfill all put
 * the photo in the same correct folder, and the boundary between days is the
 * business day the guard would recognise rather than a UTC midnight.
 *
 * Idempotent: only photos with no `photo_sync` row are uploaded, and the row is
 * written after the upload succeeds. Safe to run every few minutes.
 *
 * Usage:
 *   node scripts/sync-photos-sharepoint.js              # upload everything outstanding
 *   node scripts/sync-photos-sharepoint.js --dry-run    # show what would happen, upload nothing
 *   node scripts/sync-photos-sharepoint.js --date=2026-07-24   # only that visit date
 *   node scripts/sync-photos-sharepoint.js --self-test  # prove auth + upload + delete, no visitor data
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pool } = require('../db');
const photos = require('../lib/photos');
const sharepoint = require('../lib/sharepoint');
const { FROM_TYPE_LABEL } = require('../lib/visitQueries');

const ROOT_FOLDER = process.env.SHAREPOINT_GATEPASS_FOLDER || 'GatePass';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SELF_TEST = args.includes('--self-test');
const ONLY_DATE = (args.find((a) => a.startsWith('--date=')) || '').split('=')[1] || null;

/**
 * SharePoint rejects " * : < > ? / \ | in item names, mangles leading/trailing
 * spaces and dots, and chokes on # and % in URLs. Reduce to a safe, readable slug.
 */
function safeName(value, fallback = 'unknown') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/["*:<>?/\\|#%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[.\-]+$/g, '')
    .replace(/^[.\-]+/g, '')
    .slice(0, 60)
    .trim();
  return cleaned || fallback;
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const s = String(value);
  // Neutralise spreadsheet formula injection — this text comes from gate staff.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function selfTest() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const remote = `${ROOT_FOLDER}/.connection-test/${stamp}.txt`;
  const body = Buffer.from(
    `GatePass SharePoint connectivity test\nwritten: ${new Date().toISOString()}\n`,
    'utf8'
  );

  console.log(`[self-test] uploading ${remote} ...`);
  const item = await sharepoint.uploadFile(remote, body, { contentType: 'text/plain' });
  console.log(`[self-test] upload OK — ${item.webUrl}`);

  console.log('[self-test] deleting the test file and its folder ...');
  await sharepoint.deleteByPath(remote);
  await sharepoint.deleteByPath(`${ROOT_FOLDER}/.connection-test`);
  console.log('[self-test] cleanup OK');
  console.log('[self-test] PASSED — credentials, upload, folder creation and delete all work.');
}

/** Every photo (primary + companions) that has not yet been copied up. */
async function fetchPending() {
  const params = [config.timezone];
  let dateFilter = '';
  if (ONLY_DATE) {
    params.push(ONLY_DATE);
    dateFilter = `AND (v.created_at AT TIME ZONE $1::text)::date = $2::date`;
  }

  const { rows } = await pool.query(
    `SELECT
       p.photo_path,
       p.visit_id,
       p.kind,
       p.member_name,
       p.member_index,
       to_char(v.created_at AT TIME ZONE $1::text, 'YYYY-MM-DD') AS visit_date,
       to_char(v.created_at AT TIME ZONE $1::text, 'HH24MI')     AS visit_time,
       vis.full_name
     FROM (
       SELECT id AS visit_id, photo_path, 'VISITOR' AS kind,
              NULL::text AS member_name, 0 AS member_index
       FROM visits
       UNION ALL
       SELECT visit_id, photo_path, 'MEMBER' AS kind, name AS member_name, position AS member_index
       FROM visit_companions
     ) p
     JOIN visits   v   ON v.id = p.visit_id
     JOIN visitors vis ON vis.id = v.visitor_id
     LEFT JOIN photo_sync s ON s.photo_path = p.photo_path
     WHERE s.photo_path IS NULL
       ${dateFilter}
     ORDER BY v.created_at, p.member_index`,
    params
  );
  return rows;
}

function remotePathFor(row) {
  const who = safeName(row.full_name, 'visitor');
  const shortId = row.visit_id.slice(0, 8);
  const base = `${row.visit_time}_${who}_${shortId}`;
  const name =
    row.kind === 'MEMBER'
      ? `${base}_member${row.member_index}_${safeName(row.member_name, 'member')}.jpg`
      : `${base}.jpg`;
  return `${ROOT_FOLDER}/${row.visit_date}/${name}`;
}

/**
 * Rebuilds the day's manifest from the database and overwrites it. Regenerating
 * rather than appending keeps it correct when a visit is approved or checked out
 * after its photo was already uploaded.
 */
async function uploadManifest(dateStr) {
  const { rows } = await pool.query(
    `SELECT
       to_char(v.created_at AT TIME ZONE $1::text, 'HH24:MI') AS time_in,
       vis.full_name, vis.phone, v.from_type, v.from_detail, v.purpose, v.status,
       COALESCE(host.name, v.host_name) AS visiting,
       logger.name  AS logged_by,
       decider.name AS decided_by,
       to_char(v.decision_at    AT TIME ZONE $1::text, 'HH24:MI') AS decided_at,
       v.rejection_reason,
       to_char(v.checked_in_at  AT TIME ZONE $1::text, 'HH24:MI') AS checked_in,
       to_char(v.checked_out_at AT TIME ZONE $1::text, 'HH24:MI') AS checked_out,
       (SELECT count(*) FROM visit_companions c WHERE c.visit_id = v.id)::int AS members
     FROM visits v
     JOIN visitors vis   ON vis.id = v.visitor_id
     JOIN users    logger  ON logger.id = v.logged_by
     LEFT JOIN users host    ON host.id = v.host_admin_id
     LEFT JOIN users decider ON decider.id = v.approved_by
     WHERE (v.created_at AT TIME ZONE $1::text)::date = $2::date
     ORDER BY v.created_at`,
    [config.timezone, dateStr]
  );

  const header = [
    'Time In', 'Visitor', 'Visiting From', 'From (Company/Entity)', 'Phone', 'Members',
    'Purpose', 'Visiting', 'Logged By', 'Status', 'Decided By', 'Decided At',
    'Rejection Reason', 'Checked In', 'Checked Out',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.time_in, r.full_name, FROM_TYPE_LABEL[r.from_type] || '', r.from_detail, r.phone, r.members,
      r.purpose, r.visiting, r.logged_by, r.status, r.decided_by, r.decided_at,
      r.rejection_reason, r.checked_in, r.checked_out,
    ].map(csvCell).join(','));
  }

  // BOM so Excel reads Indian names (and future Tamil text) as UTF-8.
  const csv = Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
  const remote = `${ROOT_FOLDER}/${dateStr}/_manifest.csv`;

  if (DRY_RUN) {
    console.log(`  [dry-run] manifest ${remote} (${rows.length} visit(s))`);
    return;
  }
  await sharepoint.uploadFile(remote, csv, { contentType: 'text/csv' });
  console.log(`  manifest updated: ${remote} (${rows.length} visit(s))`);
}

async function run() {
  if (SELF_TEST) {
    await selfTest();
    return;
  }

  const pending = await fetchPending();
  if (pending.length === 0) {
    console.log('[sync] nothing to upload — all photos are already in SharePoint.');
    return;
  }

  console.log(`[sync] ${pending.length} photo(s) to upload${DRY_RUN ? ' (dry run)' : ''}`);

  const datesTouched = new Set();
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of pending) {
    const remote = remotePathFor(row);
    const local = photos.photoPath(row.photo_path);

    if (!fs.existsSync(local)) {
      // The DB references a file that is not on disk. Do not mark it synced —
      // that would hide the problem forever.
      console.warn(`  MISSING on disk, skipped: ${row.photo_path} (visit ${row.visit_id})`);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] ${row.photo_path} -> ${remote}`);
      datesTouched.add(row.visit_date);
      uploaded += 1;
      continue;
    }

    try {
      const buffer = await fs.promises.readFile(local);
      const item = await sharepoint.uploadFile(remote, buffer, { contentType: 'image/jpeg' });
      await pool.query(
        `INSERT INTO photo_sync (photo_path, visit_id, remote_path, remote_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (photo_path) DO NOTHING`,
        [row.photo_path, row.visit_id, remote, item.webUrl || null]
      );
      console.log(`  uploaded ${remote}`);
      datesTouched.add(row.visit_date);
      uploaded += 1;
    } catch (err) {
      // One bad photo must not abort the run; the rest of the day still syncs
      // and this one is retried next time because no row was written.
      console.error(`  FAILED ${row.photo_path}: ${err.message}`);
      failed += 1;
    }
  }

  for (const dateStr of datesTouched) {
    try {
      await uploadManifest(dateStr);
    } catch (err) {
      console.error(`  manifest failed for ${dateStr}: ${err.message}`);
      failed += 1;
    }
  }

  console.log(`[sync] done — ${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error('[sync] error:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
