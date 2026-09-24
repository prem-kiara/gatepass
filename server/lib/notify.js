'use strict';

/**
 * Notification service.
 *
 * The ordering here is the whole design: a notification row is INSERTed inside
 * the caller's transaction, so it commits or rolls back with the event that
 * caused it. Only afterwards — outside the transaction, fire-and-forget — do we
 * attempt a Web Push. Push is a lossy transport (device offline, permission
 * revoked, push service down); the database row is the durable record, and the
 * in-app history is what guarantees nothing is lost.
 *
 * Every function taking a `client` expects to be called inside withTransaction.
 */

const { query } = require('../db');
const push = require('./push');
const events = require('./events');

/** Who should see approval requests: every active admin plus the superadmin. */
async function approverIds(client) {
  const { rows } = await client.query(
    "SELECT id FROM users WHERE is_active = true AND role IN ('ADMIN', 'SUPERADMIN')"
  );
  return rows.map((r) => r.id);
}

/**
 * Writes one notification per recipient, in the caller's transaction.
 * Returns the created ids so the caller can hand them to deliver().
 */
async function createFor(client, userIds, { type, title, body, visitId, url, data }) {
  if (!userIds || userIds.length === 0) return [];
  const { rows } = await client.query(
    `INSERT INTO notifications (user_id, type, title, body, visit_id, url, data)
     SELECT u, $2, $3, $4, $5, $6, $7 FROM unnest($1::uuid[]) AS u
     RETURNING id, user_id`,
    [userIds, type, title, body, visitId || null, url || null, data ? JSON.stringify(data) : null]
  );
  return rows;
}

/**
 * Attempts delivery for already-committed notification rows.
 * Never throws — a push failure must not surface as a failed API request, since
 * the user's action (creating a visit, approving) has already succeeded.
 */
async function deliver(created) {
  if (!created || created.length === 0) return;

  // Live badge/list update for every recipient with an open app, independent of
  // whether the phone-shade push succeeds.
  events.notificationFor([...new Set(created.map((c) => c.user_id))]);

  await Promise.all(
    created.map(async ({ id, user_id: userId }) => {
      try {
        const { rows } = await query(
          'SELECT type, title, body, url, visit_id FROM notifications WHERE id = $1',
          [id]
        );
        if (rows.length === 0) return;
        const n = rows[0];

        const delivered = await push.pushToUser(userId, {
          id,
          type: n.type,
          title: n.title,
          body: n.body,
          url: n.url || '/',
          visitId: n.visit_id,
        });

        await query(
          `UPDATE notifications
           SET push_attempts = push_attempts + 1,
               pushed_at = CASE WHEN $2 > 0 THEN now() ELSE pushed_at END
           WHERE id = $1`,
          [id, delivered]
        );
      } catch (err) {
        console.error(`[notify] delivery failed for notification ${id}: ${err.message}`);
      }
    })
  );
}

/** Convenience: create inside the transaction, then deliver after it commits. */
function scheduleDelivery(created) {
  // Deliberately not awaited by the caller — the HTTP response should not wait
  // on a third-party push service.
  setImmediate(() => {
    deliver(created).catch((err) => console.error('[notify] deliver error:', err.message));
  });
}

/* ------------------------------------------------------------------ events */

function groupSuffix(companionCount) {
  return companionCount > 0 ? ` +${companionCount} with them` : '';
}

/** Superadmins only — security alerts are not an admin-wide broadcast. */
async function superadminIds(client) {
  const { rows } = await client.query(
    "SELECT id FROM users WHERE is_active = true AND role = 'SUPERADMIN'"
  );
  return rows.map((r) => r.id);
}

/**
 * Security tripwire — something happened to an account that a superadmin should
 * know about without going looking: a PIN locked by repeated wrong guesses, a
 * PIN reset, or a burst of failed sign-ins.
 *
 * The person who performed a reset seeing their own alert is fine; the point is
 * that the *other* superadmins see it too.
 */
async function securityAlert(client, { type, title, body, url = '/console/security' }) {
  const ids = await superadminIds(client);
  return createFor(client, ids, { type, title, body, url });
}

/** A new visit is waiting — broadcast to every admin, matching the shared queue. */
async function visitPending(client, visit) {
  const ids = await approverIds(client);
  return createFor(client, ids, {
    type: 'VISIT_PENDING',
    title: 'New visitor at the gate',
    body:
      `${visit.full_name}${visit.from_display ? ` (${visit.from_display})` : ''}` +
      `${groupSuffix(visit.companion_count)} to see ${visit.host_display}` +
      `${visit.purpose ? ` — ${visit.purpose}` : ''}`,
    visitId: visit.id,
    url: '/approvals',
    data: { logged_by: visit.logged_by_name, from: visit.from_display },
  });
}

/** The decision goes back to the guard who logged it, so they can act. */
async function visitDecided(client, visit, decidedByName) {
  const approved = visit.status === 'APPROVED';
  return createFor(client, [visit.logged_by], {
    type: approved ? 'VISIT_APPROVED' : 'VISIT_REJECTED',
    title: approved ? `Approved: ${visit.full_name}` : `Rejected: ${visit.full_name}`,
    body: approved
      ? `${decidedByName} approved the visit. You can check them in.`
      : `${decidedByName} rejected the visit.${visit.rejection_reason ? ` Reason: ${visit.rejection_reason}` : ''}`,
    visitId: visit.id,
    url: '/gate',
    data: { decided_by: decidedByName },
  });
}

/** Only the host needs to know their visitor is now inside. */
async function visitCheckedIn(client, visit) {
  if (!visit.host_admin_id) return [];
  return createFor(client, [visit.host_admin_id], {
    type: 'VISIT_CHECKED_IN',
    title: `${visit.full_name} has checked in`,
    body: `${visit.full_name}${groupSuffix(visit.companion_count)} is inside and on the way to see you.`,
    visitId: visit.id,
    url: '/approvals',
  });
}

/** The visitor's group has left — let the host know they have checked out. */
async function visitCheckedOut(client, visit) {
  if (!visit.host_admin_id) return [];
  return createFor(client, [visit.host_admin_id], {
    type: 'VISIT_CHECKED_OUT',
    title: `${visit.full_name} has checked out`,
    body: `${visit.full_name}${groupSuffix(visit.companion_count)} has left the building.`,
    visitId: visit.id,
    url: '/approvals',
  });
}

/** Nobody has acted for 10 minutes — nudge every admin once. */
async function visitUnattended(client, visit) {
  const ids = await approverIds(client);
  return createFor(client, ids, {
    type: 'VISIT_UNATTENDED',
    title: 'Visitor still waiting',
    body: `${visit.full_name} has been waiting over 10 minutes at the gate for approval.`,
    visitId: visit.id,
    url: '/approvals',
  });
}

/**
 * Marks the broadcast "please approve" notifications for a visit as resolved,
 * so the admins who did not decide are not sent to a queue that no longer has
 * this visit in it. The rows stay — resolved is not deleted.
 */
async function resolveForVisit(client, visitId, types = ['VISIT_PENDING', 'VISIT_UNATTENDED']) {
  await client.query(
    `UPDATE notifications SET resolved_at = now()
     WHERE visit_id = $1 AND type = ANY($2::text[]) AND resolved_at IS NULL`,
    [visitId, types]
  );
}

module.exports = {
  createFor,
  deliver,
  scheduleDelivery,
  securityAlert,
  superadminIds,
  visitPending,
  visitDecided,
  visitCheckedIn,
  visitCheckedOut,
  visitUnattended,
  resolveForVisit,
  approverIds,
};
