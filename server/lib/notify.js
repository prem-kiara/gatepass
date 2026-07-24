'use strict';

/**
 * v2 stub. When a visit is created we would ping the host admin (WhatsApp/SMS)
 * so they do not have to watch the queue. v1 relies on polling + a pending badge,
 * so this only logs. Wire a provider in here and nothing else needs to change.
 */
async function notifyAdmin(visit, { hostAdmin } = {}) {
  const who = hostAdmin ? `${hostAdmin.name} (${hostAdmin.phone || 'no phone'})` : 'all admins';
  console.log(`[notify] (stub) visit ${visit.id} pending approval → ${who}`);
}

module.exports = { notifyAdmin };
