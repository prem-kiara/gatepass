import { useCallback, useEffect, useState } from 'react';
import L from '../../labels';
import { admin } from '../../lib/api';
import { formatDateTime, formatTime, todayISO } from '../../lib/format';
import {
  StatusBadge, PhotoThumb, Lightbox, useLightbox, LoadingBlock,
  EmptyState, ErrorBanner, Spinner,
} from '../../components/ui';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'INSIDE', 'CHECKED_OUT'];
const PAGE = 25;

/** The audit trail — the answer to "who approved this visitor, and when". */
function AuditTrail({ visitId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    admin
      .events(visitId)
      .then(({ events: e }) => !cancelled && setEvents(e))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [visitId]);

  if (error) return <ErrorBanner error={error} />;
  if (!events) return <div className="py-3"><Spinner /></div>;

  return (
    <ol className="space-y-2 border-l-2 border-slate-200 pl-4">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className="absolute -left-[21px] top-2 h-2.5 w-2.5 rounded-full bg-brand-500" aria-hidden="true" />
          <p className="font-semibold">{L.action[e.action] || e.action}</p>
          <p className="text-sm text-slate-600">
            {e.actor_name ? `${e.actor_name} (${L.role[e.actor_role] || e.actor_role})` : '—'} ·{' '}
            {formatDateTime(e.at)}
          </p>
          {e.detail && e.detail.reason && (
            <p className="text-sm text-slate-600">{L.gate.reason}: {e.detail.reason}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function VisitRow({ visit, onOpenPhoto }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card overflow-hidden">
      {/* The thumbnail opens the lightbox, so it cannot live inside the row's
          expand button — nested buttons are invalid and swallow the inner click. */}
      <div className="flex items-center gap-3 p-3">
        <PhotoThumb filename={visit.photo_path} alt={visit.full_name} size="h-14 w-14" onOpen={onOpenPhoto} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-bold">{visit.full_name}</p>
              {visit.companion_count > 0 && (
                <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">
                  {L.gate.memberCount(visit.companion_count)}
                </span>
              )}
            </div>
            <p className="truncate text-sm text-slate-600">
              {visit.from_display ? `${visit.from_display} · ` : ''}
              {visit.phone || '—'} · {L.gate.visiting}: {visit.host_display}
            </p>
            <p className="text-sm text-slate-500">
              {formatDateTime(visit.created_at)}
              {visit.approved_by_name &&
                ` · ${
                  visit.status === 'REJECTED'
                    ? L.gate.rejectedBy(visit.approved_by_name)
                    : L.gate.approvedBy(visit.approved_by_name)
                }`}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <StatusBadge status={visit.status} />
            <p className="mt-1 text-sm text-slate-500">
              {open ? L.console.visits.collapse : L.console.visits.expand}
            </p>
          </div>
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-slate-200 bg-slate-50 px-4 py-4">
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-600">{L.console.visits.photos}</p>
            <div className="flex flex-wrap gap-3">
              <div className="w-20 text-center">
                <PhotoThumb filename={visit.photo_path} alt={visit.full_name} size="h-20 w-20" onOpen={onOpenPhoto} />
                <p className="mt-1 truncate text-xs font-semibold text-slate-700">{L.console.visits.primaryVisitor}</p>
              </div>
              {visit.companions.map((c) => (
                <div key={c.id} className="w-20 text-center">
                  <PhotoThumb filename={c.photo_path} alt={c.name} size="h-20 w-20" onOpen={onOpenPhoto} />
                  <p className="mt-1 truncate text-xs text-slate-600">{c.name}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-1 text-sm sm:grid-cols-2">
            <p><span className="text-slate-500">{L.gate.from.label}:</span> {visit.from_display || '—'}</p>
            <p><span className="text-slate-500">{L.gate.purpose}:</span> {visit.purpose || '—'}</p>
            <p><span className="text-slate-500">{L.approvals.loggedBy}:</span> {visit.logged_by_name}</p>
            <p><span className="text-slate-500">{L.gate.checkIn}:</span> {visit.checked_in_at ? formatTime(visit.checked_in_at) : '—'}</p>
            <p><span className="text-slate-500">{L.gate.checkOut}:</span> {visit.checked_out_at ? formatTime(visit.checked_out_at) : '—'}</p>
            {visit.rejection_reason && (
              <p className="sm:col-span-2"><span className="text-slate-500">{L.gate.reason}:</span> {visit.rejection_reason}</p>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-semibold text-slate-600">{L.console.visits.auditTrail}</p>
            <AuditTrail visitId={visit.id} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function Visits() {
  const [filters, setFilters] = useState({ from: '', to: '', status: '', approved_by: '', q: '' });
  const [visits, setVisits] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [admins, setAdmins] = useState([]);
  const lightbox = useLightbox();

  useEffect(() => {
    Promise.all([admin.users('ADMIN'), admin.users('SUPERADMIN')])
      .then(([a, s]) => setAdmins([...a.users, ...s.users]))
      .catch(() => setAdmins([]));
  }, []);

  const load = useCallback(
    async (nextOffset, append) => {
      setLoading(true);
      setError(null);
      try {
        const params = { limit: PAGE, offset: nextOffset };
        Object.entries(filters).forEach(([k, v]) => {
          if (v) params[k] = v;
        });
        const result = await admin.visits(params);
        setVisits((current) => (append ? [...current, ...result.visits] : result.visits));
        setTotal(result.total);
        setOffset(nextOffset);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  // Filters changing always resets to the first page.
  useEffect(() => {
    load(0, false);
  }, [load]);

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="f-from">{L.console.visits.from}</label>
            <input id="f-from" type="date" className="field" value={filters.from} max={filters.to || todayISO()}
                   onChange={(e) => setFilter('from', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="f-to">{L.console.visits.to}</label>
            <input id="f-to" type="date" className="field" value={filters.to} min={filters.from || undefined} max={todayISO()}
                   onChange={(e) => setFilter('to', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="f-status">{L.console.visits.status}</label>
            <select id="f-status" className="field" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">{L.console.visits.allStatuses}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{L.status[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-admin">{L.console.visits.approvedBy}</label>
            <select id="f-admin" className="field" value={filters.approved_by} onChange={(e) => setFilter('approved_by', e.target.value)}>
              <option value="">{L.console.visits.allAdmins}</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <input
            className="field flex-1 min-w-[12rem]"
            value={filters.q}
            onChange={(e) => setFilter('q', e.target.value)}
            placeholder={L.console.visits.searchPlaceholder}
          />
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setFilters({ from: '', to: '', status: '', approved_by: '', q: '' })}
          >
            {L.clear}
          </button>
          <a className="btn-primary" href={admin.csvUrl(filters.from || undefined)} download>
            {L.console.visits.exportCsv}
          </a>
        </div>
      </div>

      {error && <ErrorBanner error={error} onRetry={() => load(0, false)} />}

      {loading && visits.length === 0 ? (
        <LoadingBlock />
      ) : visits.length === 0 ? (
        <EmptyState title={L.console.visits.none} icon="🔍" />
      ) : (
        <>
          <p className="text-sm text-slate-500">{L.console.visits.showing(visits.length, total)}</p>
          <div className="space-y-3">
            {visits.map((v) => (
              <VisitRow key={v.id} visit={v} onOpenPhoto={lightbox.open} />
            ))}
          </div>
          {visits.length < total && (
            <button type="button" className="btn-ghost w-full" disabled={loading} onClick={() => load(offset + PAGE, true)}>
              {loading ? <Spinner className="h-5 w-5" /> : L.console.visits.loadMore}
            </button>
          )}
        </>
      )}

      <Lightbox photo={lightbox.photo} onClose={lightbox.close} />
    </div>
  );
}
