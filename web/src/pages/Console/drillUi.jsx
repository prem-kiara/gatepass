import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import L from '../../labels';
import { admin } from '../../lib/api';
import { personHref } from '../../lib/drill';
import { formatDateTime, formatTime } from '../../lib/format';
import { StatusBadge, PhotoThumb, Spinner, ErrorBanner } from '../../components/ui';
import { fmtDay } from '../../components/viz';

const F = L.console.filters;
const D = L.console.dash;

/* ------------------------------------------------------------ user names */

let namesPromise = null;
/** id -> name for every account, fetched once per page load for chip labels. */
export function useUserNames() {
  const [names, setNames] = useState({});
  useEffect(() => {
    if (!namesPromise) {
      namesPromise = admin.users()
        .then(({ users }) => Object.fromEntries(users.map((u) => [u.id, u.name])))
        .catch(() => { namesPromise = null; return {}; });
    }
    let alive = true;
    namesPromise.then((m) => alive && setNames(m));
    return () => { alive = false; };
  }, []);
  return names;
}

/* ------------------------------------------------------------ filter chips */

/**
 * Turns the URL's filters into readable, removable chips, so a drill-down
 * always says what it is showing ("Company · Axis Bank · 12 Aug – 10 Sep").
 * `visitorName` labels a visitor_id when the caller already knows it.
 */
export function describeFilters(p, names, visitorName) {
  const chips = [];
  const name = (id) => names[id] || '…';
  if (p.from || p.to) {
    const a = p.from ? fmtDay(p.from, true) : '…';
    const b = p.to ? fmtDay(p.to, true) : '…';
    chips.push({ keys: ['from', 'to'], label: p.from === p.to ? a : `${a} – ${b}` });
  }
  if (p.live) chips.push({ keys: ['live'], label: F.live[p.live] || p.live });
  if (p.stale) chips.push({ keys: ['stale'], label: F.stale[p.stale] || p.stale });
  if (p.status) chips.push({ keys: ['status'], label: L.status[p.status] || p.status });
  if (p.outcome) chips.push({ keys: ['outcome'], label: F.outcome[p.outcome] || p.outcome });
  if (p.from_type) chips.push({ keys: ['from_type'], label: D.fromTypes[p.from_type] || p.from_type });
  if (p.from_detail) chips.push({ keys: ['from_detail'], label: p.from_detail });
  if (p.no_detail) chips.push({ keys: ['no_detail'], label: F.noDetail });
  if (p.host_admin_id) chips.push({ keys: ['host_admin_id'], label: F.host(name(p.host_admin_id)) });
  if (p.host_name) chips.push({ keys: ['host_name'], label: F.host(p.host_name) });
  if (p.approved_by) chips.push({ keys: ['approved_by'], label: F.decidedBy(name(p.approved_by)) });
  if (p.logged_by) chips.push({ keys: ['logged_by'], label: F.loggedBy(name(p.logged_by)) });
  if (p.visitor_id) chips.push({ keys: ['visitor_id'], label: F.visitor(visitorName || '…') });
  if (p.dow || p.hour) {
    const day = p.dow ? D.weekdaysLong[Number(p.dow)] : '';
    const hours = p.hour !== undefined && p.hour !== '' ? D.hourRange(Number(p.hour)) : '';
    chips.push({ keys: ['dow', 'hour'], label: F.at(day, hours).trim() });
  }
  if (p.min_visits && Number(p.min_visits) > 1) chips.push({ keys: ['min_visits'], label: F.minVisits(p.min_visits) });
  if (p.q) chips.push({ keys: ['q'], label: F.search(p.q) });
  if (p.sort === 'wait_desc') chips.push({ keys: ['sort'], label: F.longestWaitFirst });
  return chips;
}

export function FilterChips({ params, onRemove, onClear, names, visitorName }) {
  const chips = describeFilters(params, names, visitorName);
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span key={c.keys.join('+')} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-3 pr-1 text-sm font-medium text-brand-800 ring-1 ring-brand-100">
          {c.label}
          <button
            type="button"
            onClick={() => onRemove(c.keys)}
            aria-label={`${F.remove}: ${c.label}`}
            className="rounded-full px-1.5 text-brand-500 hover:bg-brand-100 hover:text-brand-800"
          >
            ×
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button type="button" onClick={onClear} className="text-sm font-semibold text-slate-500 hover:text-slate-800">
          {F.clearAll}
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- a visit */

/** The audit trail — the answer to "who approved this visitor, and when". */
export function AuditTrail({ visitId }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    admin
      .events(visitId)
      .then(({ events: e }) => !cancelled && setEvents(e))
      .catch((err) => !cancelled && setError(err));
    return () => { cancelled = true; };
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
          {e.detail && e.detail.auto && (
            <p className="text-sm text-slate-500">{L.gate.autoEventAfterHours}</p>
          )}
          {e.detail && e.detail.reason && !e.detail.auto && (
            <p className="text-sm text-slate-600">{L.gate.reason}: {e.detail.reason}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function VisitRow({ visit, onOpenPhoto, linkPerson = true }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card overflow-hidden">
      {/* The thumbnail opens the lightbox, so it cannot live inside the row's
          expand button — nested buttons are invalid and swallow the inner click. */}
      <div className="flex items-center gap-3 p-3">
        <PhotoThumb filename={visit.photo_path} alt={visit.full_name} size="h-14 w-14" onOpen={onOpenPhoto} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {linkPerson ? (
              <Link to={personHref(visit.visitor_id)} className="truncate font-bold text-slate-900 hover:text-brand-700 hover:underline">
                {visit.full_name}
              </Link>
            ) : (
              <p className="truncate font-bold">{visit.full_name}</p>
            )}
            {visit.companion_count > 0 && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-bold text-brand-700">
                {L.gate.memberCount(visit.companion_count)}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="block w-full text-left"
          >
            <p className="truncate text-sm text-slate-600">
              {visit.from_display ? `${visit.from_display} · ` : ''}
              {visit.phone || '—'} · {L.gate.visiting}: {visit.host_display}
            </p>
            <p className="text-sm text-slate-500">
              {formatDateTime(visit.created_at)}
              {visit.approved_by_name &&
                ` · ${visit.status === 'REJECTED' ? L.gate.rejectedBy(visit.approved_by_name) : L.gate.approvedBy(visit.approved_by_name)}`}
            </p>
          </button>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} className="shrink-0 text-right" aria-expanded={open}>
          <StatusBadge status={visit.status} />
          <p className="mt-1 text-sm text-slate-500">{open ? L.console.visits.collapse : L.console.visits.expand}</p>
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
            <p>
              <span className="text-slate-500">{L.gate.checkOut}:</span> {visit.checked_out_at ? formatTime(visit.checked_out_at) : '—'}
              {visit.checkout_auto && <span className="text-slate-500"> ({L.gate.autoCheckedOut})</span>}
            </p>
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
