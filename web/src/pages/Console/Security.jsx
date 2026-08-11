import { useCallback, useEffect, useState } from 'react';
import L from '../../labels';
import { admin } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { LoadingBlock, EmptyState, ErrorBanner, Spinner } from '../../components/ui';

const PAGE = 100;

// Routine sign-ins are grey; anything that should catch the eye is coloured.
const TONE = {
  LOGIN_FAILED: 'border-amber-300 bg-amber-50 text-amber-800',
  PIN_LOCKED: 'border-red-300 bg-red-50 text-red-700',
  PIN_RESET: 'border-red-300 bg-red-50 text-red-700',
  PASSWORD_CHANGED: 'border-blue-300 bg-blue-50 text-blue-700',
  WEBAUTHN_REGISTERED: 'border-green-300 bg-green-50 text-green-700',
  WEBAUTHN_REMOVED: 'border-blue-300 bg-blue-50 text-blue-700',
  PIN_SET: 'border-green-300 bg-green-50 text-green-700',
  PIN_CHANGED: 'border-green-300 bg-green-50 text-green-700',
};
const DEFAULT_TONE = 'border-slate-200 bg-slate-50 text-slate-600';

export default function Security() {
  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [concerningOnly, setConcerningOnly] = useState(true);

  const load = useCallback(
    async (nextOffset, append) => {
      setLoading(true);
      try {
        const params = { limit: PAGE, offset: nextOffset };
        if (concerningOnly) params.concerning = '1';
        const result = await admin.authEventsAll(params);
        setEvents((current) => (append ? [...current, ...result.events] : result.events));
        setTotal(result.total);
        setOffset(nextOffset);
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [concerningOnly]
  );

  useEffect(() => {
    load(0, false);
  }, [load]);

  const describe = (e) => {
    const bits = [];
    if (e.method) bits.push(L.console.security.methods[e.method] || e.method);
    const reason = e.detail && e.detail.reason;
    if (reason) bits.push(L.console.security.reasons[reason] || reason);
    if (e.detail && e.detail.attempts) bits.push(`${e.detail.attempts} attempts`);
    return bits.join(' · ');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-slate-700">{L.console.security.title}</h2>
        <div className="flex gap-2">
          {[
            { key: true, label: L.console.security.concerningOnly },
            { key: false, label: L.console.security.all },
          ].map((tab) => (
            <button
              key={String(tab.key)}
              type="button"
              onClick={() => setConcerningOnly(tab.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                concerningOnly === tab.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-slate-500">🔒 {L.console.security.permanent}</p>

      {error && <ErrorBanner error={error} onRetry={() => load(0, false)} />}

      {loading && events.length === 0 ? (
        <LoadingBlock />
      ) : events.length === 0 ? (
        <EmptyState title={L.console.security.none} hint={L.console.security.noneHint} icon="🔒" />
      ) : (
        <div className="card divide-y divide-slate-100">
          {events.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className={`badge shrink-0 ${TONE[e.event] || DEFAULT_TONE}`}>
                {L.console.security.events[e.event] || e.event}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-800">
                  {e.user_name || '—'}
                  {e.username && <span className="font-normal text-slate-400"> @{e.username}</span>}
                </p>
                <p className="truncate text-sm text-slate-500">
                  {describe(e)}
                  {/* Naming the actor is the point for admin-performed actions. */}
                  {e.actor_name && e.actor_name !== e.user_name && ` · ${L.console.security.by} ${e.actor_name}`}
                </p>
              </div>
              <div className="shrink-0 text-right text-sm text-slate-500">
                <p>{formatDateTime(e.at)}</p>
                {e.ip && <p className="text-xs text-slate-400">{e.ip}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {events.length < total && (
        <div>
          <button type="button" className="btn-ghost w-full" disabled={loading} onClick={() => load(offset + PAGE, true)}>
            {loading ? <Spinner className="h-5 w-5" /> : L.console.security.loadMore}
          </button>
          <p className="mt-2 text-center text-xs text-slate-500">
            {L.console.security.showing(events.length, total)}
          </p>
        </div>
      )}
    </div>
  );
}
