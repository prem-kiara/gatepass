import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from '../labels';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { pushSupport, enablePush, sendTestPush, resyncSubscription } from '../lib/push';
import { useLiveEvent } from '../lib/live';
import { LoadingBlock, EmptyState, ErrorBanner, Spinner, Toast } from './ui';

const PAGE = 30;

const ICONS = {
  VISIT_PENDING: '🔔',
  VISIT_UNATTENDED: '⚠️',
  VISIT_APPROVED: '✅',
  VISIT_REJECTED: '⛔',
  VISIT_CHECKED_IN: '🚪',
  VISIT_CHECKED_OUT: '👋',
  SECURITY_PIN_LOCKED: '🔒',
  SECURITY_PIN_RESET: '🔑',
  SECURITY_FAILED_BURST: '🚨',
};

/**
 * Explains, per device, why alerts are or are not arriving — and offers the one
 * action that fixes it. A silent "notifications don't work" is the failure mode
 * worth designing against here.
 */
function PushSetup({ onToast }) {
  const [state, setState] = useState(() => pushSupport().state);
  const [busy, setBusy] = useState(false);

  const turnOn = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      setState(result.state);
      if (result.ok) onToast({ message: L.notifications.enabled, tone: 'success' });
    } catch (err) {
      onToast({ message: err.message || L.somethingWrong, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    try {
      const { delivered } = await sendTestPush();
      onToast(
        delivered > 0
          ? { message: L.notifications.testSent, tone: 'success' }
          : { message: L.notifications.testNoDevice, tone: 'info' }
      );
    } catch (err) {
      onToast({ message: err.message, tone: 'error' });
    }
  };

  if (state === 'granted') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-green-50 px-4 py-3">
        <p className="text-sm font-medium text-green-900">✓ {L.notifications.enabled}</p>
        <button type="button" onClick={test} className="text-sm font-semibold text-green-800 underline">
          {L.notifications.testButton}
        </button>
      </div>
    );
  }

  const panels = {
    denied: { title: L.notifications.blockedTitle, body: L.notifications.blockedBody, action: false },
    'needs-install': { title: L.notifications.installTitle, body: L.notifications.installBody, action: false },
    unsupported: { title: L.notifications.unsupportedTitle, body: L.notifications.unsupportedBody, action: false },
    'server-not-configured': { title: L.notifications.serverOffTitle, body: L.notifications.serverOffBody, action: false },
    default: { title: L.notifications.enableTitle, body: L.notifications.enableBody, action: true },
  };
  const panel = panels[state] || panels.default;

  return (
    <div className="border-b border-slate-200 bg-brand-50 px-4 py-3">
      <p className="font-semibold text-brand-900">{panel.title}</p>
      <p className="mt-0.5 text-sm text-brand-800">{panel.body}</p>
      {panel.action && (
        <button type="button" onClick={turnOn} disabled={busy} className="btn-primary mt-3 w-full">
          {busy ? <><Spinner className="h-5 w-5 text-white" /> {L.notifications.enabling}</> : L.notifications.enableButton}
        </button>
      )}
    </div>
  );
}

export default function NotificationCenter({ onClose, onChanged }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(
    async (nextOffset, append) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ limit: PAGE, offset: nextOffset });
        if (unreadOnly) qs.set('unread', '1');
        const result = await api.get(`/api/notifications?${qs}`);
        setItems((current) => (append ? [...current, ...result.notifications] : result.notifications));
        setTotal(result.total);
        setOffset(nextOffset);
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [unreadOnly]
  );

  useEffect(() => {
    load(0, false);
  }, [load]);

  // A browser can drop a subscription without telling anyone; re-register while
  // the user is looking at this panel.
  useEffect(() => {
    resyncSubscription();
  }, []);

  // A new notification arrives while the panel is open — pull it to the top.
  useLiveEvent('notification', () => load(0, false));

  const open = async (n) => {
    if (!n.read_at) {
      await api.post(`/api/notifications/${n.id}/read`).catch(() => {});
      setItems((current) => current.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      if (onChanged) onChanged();
    }
    if (n.url) {
      onClose();
      navigate(n.url);
    }
  };

  const markAll = async () => {
    try {
      await api.post('/api/notifications/read-all');
      setItems((current) => current.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
      if (onChanged) onChanged();
      if (unreadOnly) load(0, false);
    } catch (err) {
      setToast({ message: err.message, tone: 'error' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white sm:items-center sm:justify-start sm:bg-black/40 sm:p-4">
      <div className="flex h-full w-full flex-col bg-white sm:mt-12 sm:h-auto sm:max-h-[80vh] sm:max-w-lg sm:rounded-2xl sm:shadow-xl">
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="flex-1 text-lg font-bold">{L.notifications.title}</h2>
          <button type="button" onClick={markAll} className="text-sm font-semibold text-brand-700">
            {L.notifications.markAllRead}
          </button>
          <button type="button" onClick={onClose} className="p-2 text-2xl leading-none text-slate-500" aria-label={L.close}>
            ×
          </button>
        </header>

        <PushSetup onToast={setToast} />

        <div className="flex gap-2 border-b border-slate-200 px-4 py-2">
          {[
            { key: false, label: L.notifications.all },
            { key: true, label: L.notifications.unreadOnly },
          ].map((tab) => (
            <button
              key={String(tab.key)}
              type="button"
              onClick={() => setUnreadOnly(tab.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                unreadOnly === tab.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && <div className="p-4"><ErrorBanner error={error} onRetry={() => load(0, false)} /></div>}

          {loading && items.length === 0 ? (
            <LoadingBlock />
          ) : items.length === 0 ? (
            <div className="p-4">
              <EmptyState title={L.notifications.none} hint={L.notifications.noneHint} icon="🔔" />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n)}
                    className={`flex w-full gap-3 px-4 py-3 text-left ${n.read_at ? '' : 'bg-brand-50/60'}`}
                  >
                    <span className="mt-0.5 text-xl" aria-hidden="true">{ICONS[n.type] || '🔔'}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`truncate ${n.read_at ? 'font-semibold' : 'font-bold'}`}>{n.title}</span>
                        {!n.read_at && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-hidden="true" />}
                      </span>
                      <span className="mt-0.5 block text-sm text-slate-600">{n.body}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        {formatDateTime(n.created_at)}
                        {/* A broadcast someone else already actioned — say so rather
                            than sending this admin to an empty queue. */}
                        {n.resolved_at && (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 font-semibold text-slate-600">
                            {L.notifications.handled}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {items.length < total && (
          <div className="border-t border-slate-200 p-3">
            <button type="button" className="btn-ghost w-full" disabled={loading} onClick={() => load(offset + PAGE, true)}>
              {loading ? <Spinner className="h-5 w-5" /> : L.notifications.loadMore}
            </button>
            <p className="mt-2 text-center text-xs text-slate-500">
              {L.notifications.showingCount(items.length, total)}
            </p>
          </div>
        )}
      </div>

      <Toast message={toast && toast.message} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
