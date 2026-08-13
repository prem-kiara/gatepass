'use strict';

/**
 * Periodic background work, run in-process (there is a single PM2 instance).
 *
 *  1. Escalate requests nobody has acted on for 10 minutes.
 *  2. Retry pushes that never reached any device.
 *
 * (2) is what makes "nothing should be lost" true in practice: the notification
 * row is already safe in the database, but a guard whose phone was in a tunnel
 * when the request came in should still get the buzz once it reconnects, not
 * only when they next open the app.
 */

const config = require('../config');
const { query, withTransaction } = require('../db');
const notify = require('./notify');
const events = require('./events');

const INTERVAL_MS = 60 * 1000;
const MAX_PUSH_ATTEMPTS = 5;

/** One VISIT_UNATTENDED per visit — the NOT EXISTS makes repeat sweeps a no-op. */
async function escalateUnattended() {
  const { rows } = await query(
    `SELECT v.id, vis.full_name
     FROM visits v
     JOIN visitors vis ON vis.id = v.visitor_id
     WHERE v.status = 'PENDING'
       AND EXTRACT(EPOCH FROM (now() - v.created_at)) >= $1
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.visit_id = v.id AND n.type = 'VISIT_UNATTENDED'
       )`,
    [config.unattendedAfterSeconds]
  );

  for (const visit of rows) {
    try {
      const created = await withTransaction((client) => notify.visitUnattended(client, visit));
      notify.scheduleDelivery(created);
      events.approvalsChanged({ visitId: visit.id, action: 'unattended' });
      console.log(`[sweeper] escalated unattended visit ${visit.id} (${visit.full_name})`);
    } catch (err) {
      console.error(`[sweeper] escalation failed for ${visit.id}: ${err.message}`);
    }
  }
}

/**
 * Retries anything still undelivered. Bounded by attempt count and age so a
 * permanently unreachable device cannot generate work forever.
 */
async function retryUndelivered() {
  const { rows } = await query(
    `SELECT id, user_id FROM notifications
     WHERE pushed_at IS NULL
       AND push_attempts < $1
       AND created_at > now() - interval '24 hours'
     ORDER BY created_at
     LIMIT 100`,
    [MAX_PUSH_ATTEMPTS]
  );
  if (rows.length === 0) return;

  await notify.deliver(rows.map((r) => ({ id: r.id, user_id: r.user_id })));
}

const FAILED_BURST = 3;          // failures against one account...
const FAILED_WINDOW_MINUTES = 10; // ...within this window is worth a look

// Thresholds for the per-source check below. Deliberately as low as the
// per-account one: unlike a fumbled password, neither of these patterns has an
// innocent explanation, so we can afford to be twitchy.
const UNKNOWN_PROBE_BURST = 3;   // sign-ins against usernames that do not exist
const SPRAY_ACCOUNTS = 3;        // distinct real accounts hit from one address

/**
 * Flags a burst of failed sign-ins against a single account.
 *
 * One fat-fingered password is noise; three in ten minutes is either someone
 * locked out and struggling (worth helping) or someone guessing (worth
 * knowing). Alerts once per burst — the NOT EXISTS check against recent
 * notifications is what stops it firing every minute while the burst continues.
 */
async function alertFailedBursts() {
  const { rows } = await query(
    `SELECT e.user_id, u.name, count(*)::int AS failures, max(e.at) AS latest
     FROM auth_events e
     JOIN users u ON u.id = e.user_id
     WHERE e.event = 'LOGIN_FAILED'
       AND e.at > now() - ($1 || ' minutes')::interval
     GROUP BY e.user_id, u.name
     HAVING count(*) >= $2
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.type = 'SECURITY_FAILED_BURST'
           AND n.data->>'about' = e.user_id::text
           AND n.created_at > now() - ($1 || ' minutes')::interval
       )`,
    [String(FAILED_WINDOW_MINUTES), FAILED_BURST]
  );

  for (const row of rows) {
    try {
      const created = await withTransaction(async (client) => {
        const ids = await notify.superadminIds(client);
        return notify.createFor(client, ids, {
          type: 'SECURITY_FAILED_BURST',
          title: 'Repeated failed sign-ins',
          body: `${row.name} — ${row.failures} failed attempts in the last ${FAILED_WINDOW_MINUTES} minutes.`,
          url: '/console/security',
          data: { about: row.user_id, failures: row.failures },
        });
      });
      notify.scheduleDelivery(created);
      console.log(`[sweeper] flagged ${row.failures} failed sign-ins for ${row.name}`);
    } catch (err) {
      console.error(`[sweeper] failed-burst alert failed: ${err.message}`);
    }
  }
}

/**
 * Flags a suspicious *source* — the patterns the per-account check cannot see.
 *
 * That check groups by user, so it is structurally blind to:
 *  - **probing**: sign-ins against usernames that do not exist. Those rows have
 *    no user_id to group by, so however many arrive, nothing ever fires.
 *  - **spraying**: one password tried against many real accounts. Each account
 *    sees a single failure, which is under the per-account threshold forever.
 *
 * Both are "one source, many targets", so the grouping key here is the address.
 * Guards fumbling their own PIN on the shared gate phone do not trip it: those
 * failures resolve to a real user, and it takes three *different* accounts from
 * one address to count as spraying.
 */
async function alertSuspiciousSources() {
  const { rows } = await query(
    `SELECT e.ip,
            count(*) FILTER (WHERE e.user_id IS NULL)::int AS unknown_attempts,
            count(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL)::int AS accounts_hit,
            -- Attacker-controlled text; trimmed here and capped again below.
            (array_agg(DISTINCT left(e.detail->>'username', 40))
               FILTER (WHERE e.user_id IS NULL AND e.detail->>'username' IS NOT NULL)
            )[1:3] AS sample_usernames
     FROM auth_events e
     WHERE e.event = 'LOGIN_FAILED'
       AND e.at > now() - ($1 || ' minutes')::interval
       AND e.ip IS NOT NULL
     GROUP BY e.ip
     HAVING (count(*) FILTER (WHERE e.user_id IS NULL) >= $2
             OR count(DISTINCT e.user_id) FILTER (WHERE e.user_id IS NOT NULL) >= $3)
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.type = 'SECURITY_SUSPICIOUS_SOURCE'
           AND n.data->>'source_ip' = e.ip
           AND n.created_at > now() - ($1 || ' minutes')::interval
       )`,
    [String(FAILED_WINDOW_MINUTES), UNKNOWN_PROBE_BURST, SPRAY_ACCOUNTS]
  );

  for (const row of rows) {
    try {
      const parts = [];
      if (row.unknown_attempts >= UNKNOWN_PROBE_BURST) {
        const names = (row.sample_usernames || []).filter(Boolean);
        parts.push(
          `${row.unknown_attempts} attempt(s) on usernames that don't exist` +
          (names.length ? ` (${names.join(', ')})` : '')
        );
      }
      if (row.accounts_hit >= SPRAY_ACCOUNTS) {
        parts.push(`failed sign-ins across ${row.accounts_hit} different accounts`);
      }

      const created = await withTransaction(async (client) => {
        const ids = await notify.superadminIds(client);
        return notify.createFor(client, ids, {
          type: 'SECURITY_SUSPICIOUS_SOURCE',
          title: 'Suspicious sign-in activity',
          body: `From ${row.ip}: ${parts.join('; ')} in the last ${FAILED_WINDOW_MINUTES} minutes.`,
          url: '/console/security',
          data: {
            source_ip: row.ip,
            unknown_attempts: row.unknown_attempts,
            accounts_hit: row.accounts_hit,
          },
        });
      });
      notify.scheduleDelivery(created);
      console.log(`[sweeper] flagged suspicious source ${row.ip} (${parts.join('; ')})`);
    } catch (err) {
      console.error(`[sweeper] suspicious-source alert failed: ${err.message}`);
    }
  }
}

let timer = null;

async function tick() {
  try {
    await escalateUnattended();
    await alertFailedBursts();
    await alertSuspiciousSources();
    await retryUndelivered();
  } catch (err) {
    console.error('[sweeper] tick failed:', err.message);
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  if (timer.unref) timer.unref();
  console.log(`[sweeper] running every ${INTERVAL_MS / 1000}s`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  tick,
  escalateUnattended,
  retryUndelivered,
  alertFailedBursts,
  alertSuspiciousSources,
};
