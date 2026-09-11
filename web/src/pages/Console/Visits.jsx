import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import L from '../../labels';
import { admin } from '../../lib/api';
import { todayISO } from '../../lib/format';
import { Lightbox, useLightbox, LoadingBlock, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { FilterChips, VisitRow, useUserNames } from './drillUi';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'INSIDE', 'CHECKED_OUT'];
const PAGE = 25;

/**
 * The visit list — and the drill-down target for every dashboard number.
 *
 * All filters live in the URL, so a drill-down is a shareable link, the back
 * button returns to the dashboard, and the chips above the list always say
 * exactly what is being shown. The server's count for these filters is the
 * same number the dashboard tile displayed.
 */
export default function Visits() {
  const [sp, setSp] = useSearchParams();
  const params = Object.fromEntries(sp.entries());
  const key = sp.toString();
  const names = useUserNames();
  const lightbox = useLightbox();

  const [visits, setVisits] = useState([]);
  const [total, setTotal] = useState(0);
  const [people, setPeople] = useState(0);
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
      const result = await admin.visits({ ...Object.fromEntries(new URLSearchParams(key)), limit: PAGE, offset: nextOffset });
      if (ticket !== latest.current) return;
      setVisits((current) => (append ? [...current, ...result.visits] : result.visits));
      setTotal(result.total);
      setPeople(result.people);
      setOffset(nextOffset);
    } catch (err) {
      if (ticket === latest.current) setError(err);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => { load(0, false); }, [load]);

  // Debounce typing into the URL rather than firing a request per keystroke.
  useEffect(() => {
    if ((params.q || '') === search) return undefined;
    const t = setTimeout(() => setParam('q', search), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function setParam(k, v) {
    const next = new URLSearchParams(sp);
    if (v === '' || v === null || v === undefined) next.delete(k);
    else next.set(k, v);
    setSp(next);
  }
  const removeKeys = (keys) => {
    const next = new URLSearchParams(sp);
    keys.forEach((k) => next.delete(k));
    if (keys.includes('q')) setSearch('');
    setSp(next);
  };
  const clearAll = () => { setSearch(''); setSp(new URLSearchParams()); };

  const visitorName = params.visitor_id && visits[0] ? visits[0].full_name : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/console" className="text-sm font-semibold text-brand-700 hover:underline">
          {L.console.filters.backToDashboard}
        </Link>
        <a className="btn-ghost !py-1.5 text-sm" href={admin.visitsCsvUrl(params)} download>
          {L.console.visits.exportCsv}
        </a>
      </div>

      <FilterChips params={params} names={names} visitorName={visitorName} onRemove={removeKeys} onClear={clearAll} />

      <div className="card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
        <input
          className="field lg:col-span-2"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={L.console.visits.searchPlaceholder}
          aria-label={L.search}
        />
        <input type="date" className="field" value={params.from || ''} max={params.to || todayISO()}
               onChange={(e) => setParam('from', e.target.value)} aria-label={L.console.visits.from} />
        <input type="date" className="field" value={params.to || ''} min={params.from || undefined} max={todayISO()}
               onChange={(e) => setParam('to', e.target.value)} aria-label={L.console.visits.to} />
        <select className="field" value={params.status || ''} onChange={(e) => setParam('status', e.target.value)}
                aria-label={L.console.visits.status}>
          <option value="">{L.console.visits.allStatuses}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{L.status[s]}</option>)}
        </select>
      </div>

      {error && <ErrorBanner error={error} onRetry={() => load(0, false)} />}

      {loading && visits.length === 0 ? (
        <LoadingBlock />
      ) : visits.length === 0 ? (
        <EmptyState title={L.console.visits.none} icon="🔍" />
      ) : (
        <div className={`space-y-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <p className="text-sm font-semibold text-slate-700">
            {L.console.filters.summary(total, people)}
            <span className="font-normal text-slate-500"> · {L.console.visits.showing(visits.length, total)}</span>
          </p>
          {visits.map((v) => (
            <VisitRow key={v.id} visit={v} onOpenPhoto={lightbox.open} />
          ))}
          {visits.length < total && (
            <button type="button" className="btn-ghost w-full" disabled={loading} onClick={() => load(offset + PAGE, true)}>
              {loading ? <Spinner className="h-5 w-5" /> : L.console.visits.loadMore}
            </button>
          )}
        </div>
      )}

      <Lightbox photo={lightbox.photo} onClose={lightbox.close} />
    </div>
  );
}
