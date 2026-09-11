import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import L from '../../labels';
import { admin } from '../../lib/api';
import { drillHref, personHref } from '../../lib/drill';
import { formatDateTime } from '../../lib/format';
import { LoadingBlock, EmptyState, ErrorBanner, Spinner, PhotoImage } from '../../components/ui';
import { FilterChips, useUserNames } from './drillUi';

const P = L.console.people;
const PAGE = 30;

/**
 * Everyone who visited, one row per person — the drill-down behind "Different
 * visitors" and "Came back 2+ times". Filters live in the URL like the visit
 * list, and each row's visit count opens exactly those visits.
 */
export default function People() {
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries(sp.entries());
  const key = sp.toString();
  const names = useUserNames();

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(params.q || '');
  const latest = useRef(0);

  const load = useCallback(async (nextOffset, append) => {
    const ticket = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const result = await admin.visitors({ ...Object.fromEntries(new URLSearchParams(key)), limit: PAGE, offset: nextOffset });
      if (ticket !== latest.current) return;
      setRows((current) => (append ? [...current, ...result.visitors] : result.visitors));
      setTotal(result.total);
      setOffset(nextOffset);
    } catch (err) {
      if (ticket === latest.current) setError(err);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => { load(0, false); }, [load]);

  function setParam(k, v) {
    const next = new URLSearchParams(sp);
    if (v === '' || v === null || v === undefined) next.delete(k);
    else next.set(k, v);
    setSp(next);
  }
  useEffect(() => {
    if ((params.q || '') === search) return undefined;
    const t = setTimeout(() => setParam('q', search), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const removeKeys = (keys) => {
    const next = new URLSearchParams(sp);
    keys.forEach((k) => next.delete(k));
    if (keys.includes('q')) setSearch('');
    setSp(next);
  };

  return (
    <div className="space-y-4">
      <Link to="/console" className="text-sm font-semibold text-brand-700 hover:underline">
        {L.console.filters.backToDashboard}
      </Link>
      <h2 className="text-lg font-bold text-slate-800">{P.title}</h2>

      <FilterChips params={params} names={names} onRemove={removeKeys} onClear={() => { setSearch(''); setSp(new URLSearchParams()); }} />

      <div className="card flex flex-wrap items-center gap-3 p-3">
        <input className="field min-w-[12rem] flex-1" value={search} onChange={(e) => setSearch(e.target.value)}
               placeholder={P.searchPlaceholder} aria-label={L.search} />
        <select className="field w-auto" value={params.sort || 'recent'} onChange={(e) => setParam('sort', e.target.value)}
                aria-label={P.sort}>
          {Object.entries(P.sorts).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" className="h-5 w-5" checked={Number(params.min_visits || 1) >= 2}
                 onChange={(e) => setParam('min_visits', e.target.checked ? '2' : '')} />
          {L.console.dash.repeatVisitors}
        </label>
      </div>

      {error && <ErrorBanner error={error} onRetry={() => load(0, false)} />}

      {loading && rows.length === 0 ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyState title={P.none} icon="👤" />
      ) : (
        <div className={`space-y-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <p className="text-sm font-semibold text-slate-700">{P.count(total)}</p>
          <ul className="card divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.visitor_id} className="flex items-center gap-3 p-3">
                <Link to={personHref(r.visitor_id)} className="flex min-w-0 flex-1 items-center gap-3">
                  <PhotoImage filename={r.photo_path} alt={r.full_name} size="h-12 w-12" />
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-slate-900 hover:underline">{r.full_name}</span>
                    <span className="block truncate text-sm text-slate-600">
                      {r.phone || P.noPhone}
                      {r.last_from_display ? ` · ${r.last_from_display}` : ''}
                      {r.last_host ? ` · ${L.gate.visiting}: ${r.last_host}` : ''}
                    </span>
                    <span className="block text-xs text-slate-500">{L.console.dash.lastSeen} {formatDateTime(r.last_visit_at)}</span>
                  </span>
                </Link>
                <div className="shrink-0 text-right">
                  <Link to={drillHref(r.visits.drill)} className="block text-sm font-semibold text-brand-700 hover:underline">
                    {L.console.dash.visitsCount(r.visits.value)}
                  </Link>
                  {r.lifetime_visits !== r.visits.value && (
                    <span className="block text-xs text-slate-500">{P.lifetime(r.lifetime_visits)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {rows.length < total && (
            <button type="button" className="btn-ghost w-full" disabled={loading} onClick={() => load(offset + PAGE, true)}>
              {loading ? <Spinner className="h-5 w-5" /> : P.loadMore}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
