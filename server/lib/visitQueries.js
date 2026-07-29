'use strict';

const config = require('../config');

/**
 * One shared projection for a visit so every screen (gate, approvals, console)
 * sees identically shaped data — including companions as a nested array.
 * Callers append their own WHERE/ORDER/LIMIT and number their own parameters;
 * this projection itself binds nothing.
 */
const VISIT_SELECT = `
  SELECT
    v.id,
    v.status,
    v.purpose,
    v.from_type,
    v.from_detail,
    v.photo_path,
    v.host_admin_id,
    v.host_name,
    v.logged_by,
    v.approved_by,
    v.rejection_reason,
    v.created_at,
    v.decision_at,
    v.checked_in_at,
    v.checked_out_at,
    vis.id   AS visitor_id,
    vis.full_name,
    vis.phone,
    host.name     AS host_admin_name,
    logger.name   AS logged_by_name,
    decider.name  AS approved_by_name,
    decider.role  AS approved_by_role,
    EXTRACT(EPOCH FROM (now() - v.created_at))::int AS waiting_seconds,
    COALESCE(comp.items, '[]'::json) AS companions
  FROM visits v
  JOIN visitors vis   ON vis.id = v.visitor_id
  JOIN users logger   ON logger.id = v.logged_by
  LEFT JOIN users host    ON host.id = v.host_admin_id
  LEFT JOIN users decider ON decider.id = v.approved_by
  LEFT JOIN LATERAL (
    SELECT json_agg(
             json_build_object('id', vc.id, 'name', vc.name, 'photo_path', vc.photo_path)
             ORDER BY vc.position, vc.id
           ) AS items
    FROM visit_companions vc
    WHERE vc.visit_id = v.id
  ) comp ON true
`;

/**
 * Matches rows created on the current local day; parameter $n is the timezone.
 * The explicit ::text cast is required — without it Postgres cannot infer the
 * parameter's type from `AT TIME ZONE` alone and rejects the statement.
 */
function todayClause(paramIndex) {
  return `(v.created_at AT TIME ZONE $${paramIndex}::text)::date = (now() AT TIME ZONE $${paramIndex}::text)::date`;
}

const FROM_TYPE_LABEL = { COMPANY: 'Company', PRIVATE: 'Private', GOVERNMENT: 'Government entity' };

/**
 * One human string for where the visitor is from, used by cards, CSV, the
 * SharePoint manifest and notifications so they never drift apart.
 *   COMPANY/GOVERNMENT -> the detail (the company or entity name)
 *   PRIVATE            -> "Private", plus the detail if the guard added one
 */
function fromDisplay(fromType, fromDetail) {
  if (!fromType) return null;
  const detail = fromDetail ? String(fromDetail).trim() : '';
  if (fromType === 'PRIVATE') return detail ? `Private — ${detail}` : 'Private';
  return detail || FROM_TYPE_LABEL[fromType] || null;
}

/** Adds the derived flags the UI needs but that do not belong in the database. */
function decorate(row) {
  return {
    ...row,
    host_display: row.host_admin_name || row.host_name,
    from_display: fromDisplay(row.from_type, row.from_detail),
    from_type_label: row.from_type ? FROM_TYPE_LABEL[row.from_type] : null,
    companion_count: Array.isArray(row.companions) ? row.companions.length : 0,
    unattended: row.status === 'PENDING' && row.waiting_seconds >= config.unattendedAfterSeconds,
  };
}

module.exports = { VISIT_SELECT, todayClause, decorate, fromDisplay, FROM_TYPE_LABEL };
