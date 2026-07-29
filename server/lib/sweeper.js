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

let timer = null;

async function tick() {
  try {
    await escalateUnattended();
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

module.exports = { start, stop, tick, escalateUnattended, retryUndelivered };
