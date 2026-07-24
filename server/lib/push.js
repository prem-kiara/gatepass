'use strict';

/**
 * Web Push transport (VAPID).
 *
 * This is the only way a PWA can put a message in the phone's notification
 * shade without a native app. It is deliberately treated as *best effort*:
 * every notification is already committed to the `notifications` table before
 * we get here, so a push that never arrives costs visibility, never the record.
 *
 * Platform notes that matter operationally:
 *  - Android/Chrome: works whether or not the app is installed.
 *  - iOS/Safari: works only when the app has been added to the Home Screen
 *    (iOS 16.4+). In a Safari tab the subscribe call simply is not available.
 */

const webpush = require('web-push');
const config = require('../config');
const { query } = require('../db');

let configured = false;

function isConfigured() {
  if (configured) return true;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  configured = true;
  return true;
}

function publicKey() {
  return config.vapid.publicKey || null;
}

async function saveSubscription(userId, subscription, userAgent) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    const err = new Error('That push subscription is incomplete.');
    err.status = 400;
    throw err;
  }

  // Endpoints are unique per device+browser. Re-subscribing (or a browser
  // rotating its keys) must update in place rather than pile up duplicates,
  // and must clear any previous disabled state.
  const { rows } = await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           failure_count = 0,
           disabled_at = NULL
     RETURNING id`,
    [userId, endpoint, keys.p256dh, keys.auth, (userAgent || '').slice(0, 300)]
  );
  return rows[0].id;
}

async function removeSubscription(userId, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/**
 * Pushes one payload to every live device belonging to `userId`.
 * Returns the number of devices that accepted it.
 *
 * A 404/410 means the browser threw the subscription away (app uninstalled,
 * data cleared). That device is disabled rather than retried forever.
 */
async function pushToUser(userId, payload) {
  if (!isConfigured()) return 0;

  const { rows: subs } = await query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 AND disabled_at IS NULL',
    [userId]
  );
  if (subs.length === 0) return 0;

  const body = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { TTL: 24 * 60 * 60, urgency: 'high' }
        );
        delivered += 1;
        await query(
          'UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1',
          [sub.id]
        );
      } catch (err) {
        const status = err.statusCode;
        if (status === 404 || status === 410) {
          await query('UPDATE push_subscriptions SET disabled_at = now() WHERE id = $1', [sub.id]);
        } else {
          // Transient (network, push service 5xx). Count it; the notification
          // row stays undelivered so the sweeper retries it.
          await query(
            'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1',
            [sub.id]
          );
          console.warn(`[push] send failed for subscription ${sub.id}: ${status || err.message}`);
        }
      }
    })
  );

  return delivered;
}

module.exports = { isConfigured, publicKey, saveSubscription, removeSubscription, pushToUser };
