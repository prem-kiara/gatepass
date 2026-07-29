'use strict';

/**
 * Writes to the append-only auth audit log (`auth_events`).
 *
 * This is the record that makes "no foulplay" checkable: every sign-in and its
 * method, every failed attempt, every PIN change, and every superadmin reset is
 * kept permanently, tied to the account it concerns and to whoever performed it.
 *
 * Never let a logging failure break the request it describes — an auth action
 * must not fail because its audit row could not be written; we log the error and
 * carry on. (The row is best-effort; the credential change it records already
 * happened in its own statement.)
 */

const { query } = require('../db');

function clientIp(req) {
  if (!req) return null;
  // trust proxy is set, so req.ip already reflects X-Forwarded-For.
  return (req.ip || '').slice(0, 45) || null;
}

async function logAuth({ userId = null, actorId = null, event, method = null, req = null, detail = null }) {
  try {
    await query(
      `INSERT INTO auth_events (user_id, actor_id, event, method, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        actorId,
        event,
        method,
        clientIp(req),
        req ? (req.get('user-agent') || '').slice(0, 300) : null,
        detail ? JSON.stringify(detail) : null,
      ]
    );
  } catch (err) {
    console.error(`[authlog] failed to record ${event}: ${err.message}`);
  }
}

module.exports = { logAuth };
