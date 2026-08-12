import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';

/**
 * Real-time updates over Server-Sent Events.
 *
 * One EventSource is held for the whole app while a user is logged in. Server
 * events are re-dispatched on an in-memory EventTarget so any number of screens
 * can subscribe with useLiveEvent without each opening its own connection.
 *
 * The events are hints ("the queue changed"), not data — a screen reacts by
 * re-fetching. The existing polling stays in place as a fallback, so if SSE is
 * unavailable (old WebView) or the connection drops, screens still update, just
 * a little less instantly.
 */

const LiveContext = createContext(null);

const EVENT_TYPES = ['approvals_changed', 'gate_changed', 'notification'];

export function LiveProvider({ children }) {
  const { user } = useAuth();
  const targetRef = useRef(null);
  if (!targetRef.current) targetRef.current = new EventTarget();
  const [, setConnected] = useState(false);

  // A session still on a temporary PIN is refused by /api/events (403), and
  // EventSource treats that as fatal — it does not retry. Since the guard is
  // about to replace that PIN, connecting now would burn the one connection
  // attempt and leave the gate on polling until a manual reload. Wait, and let
  // must_change_pin flipping to false below re-run this effect and connect.
  const pendingPinChange = Boolean(user && user.must_change_pin);

  useEffect(() => {
    // Only connect when logged in; the endpoint requires auth and would just
    // 401-loop otherwise. Reconnects cleanly on login/logout and once a forced
    // PIN change completes, because both are dependencies below.
    if (!user || pendingPinChange || typeof EventSource === 'undefined') return undefined;

    const target = targetRef.current;
    const source = new EventSource('/api/events', { withCredentials: true });

    const forward = (type) => (e) => {
      let detail = {};
      try {
        detail = e.data ? JSON.parse(e.data) : {};
      } catch (err) {
        /* ignore malformed frames */
      }
      target.dispatchEvent(new CustomEvent(type, { detail }));
    };

    const handlers = EVENT_TYPES.map((type) => {
      const h = forward(type);
      source.addEventListener(type, h);
      return [type, h];
    });

    source.onopen = () => setConnected(true);
    source.onerror = () => {
      // EventSource reconnects on its own; just reflect state. Polling covers the gap.
      setConnected(false);
    };

    return () => {
      handlers.forEach(([type, h]) => source.removeEventListener(type, h));
      source.close();
    };
  }, [user && user.id, pendingPinChange]);

  return <LiveContext.Provider value={targetRef.current}>{children}</LiveContext.Provider>;
}

/**
 * Run `handler(type, detail)` whenever one of `types` arrives from the server.
 * `handler` is kept in a ref so callers can pass an inline function without
 * re-subscribing every render.
 */
export function useLiveEvent(types, handler) {
  const target = useContext(LiveContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const list = Array.isArray(types) ? types : [types];
  const key = list.join(',');

  useEffect(() => {
    if (!target) return undefined;
    const listener = (e) => handlerRef.current(e.type, e.detail);
    list.forEach((t) => target.addEventListener(t, listener));
    return () => list.forEach((t) => target.removeEventListener(t, listener));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, key]);
}
