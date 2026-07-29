'use strict';

/**
 * In-process event bus for real-time (Server-Sent Events) fan-out.
 *
 * There is a single PM2 instance, so a plain EventEmitter reaches every open SSE
 * connection — no Redis or external broker needed. If this ever runs multiple
 * instances, this is the one piece that would need a shared pub/sub behind it.
 *
 * An event is { type, scope, data }:
 *   scope.roles   — deliver to any connected user with one of these roles
 *   scope.userIds — deliver to these specific users (e.g. the guard who logged a visit)
 * A connection receives the event if it matches roles OR userIds.
 *
 * Events are hints, not state: the client reacts by re-fetching the relevant
 * endpoint. That keeps the wire format trivial and means a missed event (a
 * reconnect gap) self-heals on the next event or the polling fallback, with no
 * divergent client state to reconcile.
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Every SSE connection adds a listener; there is no sensible fixed ceiling.
bus.setMaxListeners(0);

function publish(type, { roles = null, userIds = null, data = {} } = {}) {
  bus.emit('event', { type, scope: { roles, userIds }, data });
}

const APPROVERS = ['ADMIN', 'SUPERADMIN'];

/**
 * Convenience publishers for the two list views. Called after the DB commit so a
 * client that re-fetches on the hint always sees the committed state.
 *   approvalsChanged — the shared pending queue changed (new request / decision)
 *   gateChanged      — a gate visit's status changed (decision / check-in / out)
 */
function approvalsChanged(data = {}) {
  publish('approvals_changed', { roles: APPROVERS, data });
}
function gateChanged(data = {}) {
  publish('gate_changed', { roles: ['SECURITY'], data });
}
/** A user's notification list / unread count changed. */
function notificationFor(userIds, data = {}) {
  if (userIds && userIds.length) publish('notification', { userIds, data });
}

/** True if a connection for `user` should receive `event`. */
function matches(event, user) {
  const { roles, userIds } = event.scope || {};
  if (roles && roles.includes(user.role)) return true;
  if (userIds && userIds.includes(user.id)) return true;
  return false;
}

module.exports = { bus, publish, matches, approvalsChanged, gateChanged, notificationFor };
