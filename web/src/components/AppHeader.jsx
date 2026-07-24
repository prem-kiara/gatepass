import { useCallback, useState } from 'react';
import L from '../labels';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import NotificationCenter from './NotificationCenter';

const UNREAD_POLL_MS = 20000;

/**
 * Deliberately flat: title, who is signed in, notifications, and log out.
 * No hamburger menu — security staff should never have to hunt for anything.
 */
export default function AppHeader({ title, right }) {
  const { user, logout } = useAuth();
  const [showNotifications, setShowNotifications] = useState(false);

  const fetchUnread = useCallback(() => api.get('/api/notifications/unread-count'), []);
  const { data, reload } = usePoll(fetchUnread, UNREAD_POLL_MS, []);
  const unread = (data && data.unread) || 0;

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-brand-700 bg-brand-600 text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold">{title}</h1>
            {user && (
              <p className="truncate text-sm text-brand-100">
                {user.name} · {L.role[user.role]}
              </p>
            )}
          </div>

          {right}

          <button
            type="button"
            onClick={() => setShowNotifications(true)}
            className="relative shrink-0 rounded-lg border border-brand-500 px-3 py-2 hover:bg-brand-700"
            aria-label={`${L.notifications.open}${unread > 0 ? ` (${unread})` : ''}`}
          >
            <span className="text-lg" aria-hidden="true">🔔</span>
            {unread > 0 && (
              <span className="absolute -right-1.5 -top-1.5 min-w-[20px] rounded-full bg-amber-500 px-1.5 py-0.5 text-xs font-bold text-white">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={logout}
            className="shrink-0 rounded-lg border border-brand-500 px-3 py-2 text-sm font-semibold hover:bg-brand-700"
          >
            {L.logout}
          </button>
        </div>
      </header>

      {showNotifications && (
        <NotificationCenter
          onClose={() => setShowNotifications(false)}
          onChanged={() => reload({ silent: true }).catch(() => {})}
        />
      )}
    </>
  );
}
