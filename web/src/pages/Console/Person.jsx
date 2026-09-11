import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import L from '../../labels';
import { admin } from '../../lib/api';
import { drillHref } from '../../lib/drill';
import { formatDateTime } from '../../lib/format';
import { Lightbox, useLightbox, LoadingBlock, EmptyState, ErrorBanner, Spinner, PhotoThumb } from '../../components/ui';
import { StatTile, fmtNum } from '../../components/viz';
import { VisitRow } from './drillUi';

const P = L.console.person;
const D = L.console.dash;
const PAGE = 20;

/** One person's whole history with the gate, every number a drill-down. */
export default function Person() {
  const { id } = useParams();
  const navigate = useNavigate();
  const lightbox = useLightbox();

  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [visits, setVisits] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loadingVisits, setLoadingVisits] = useState(true);

  useEffect(() => {
    let alive = true;
    setProfile(null);
    admin.visitor(id).then((p) => alive && setProfile(p)).catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [id]);

  const loadVisits = useCallback(async (nextOffset, append) => {
    setLoadingVisits(true);
    try {
      const r = await admin.visits({ visitor_id: id, limit: PAGE, offset: nextOffset });
      setVisits((cur) => (append ? [...cur, ...r.visits] : r.visits));
      setTotal(r.total);
      setOffset(nextOffset);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingVisits(false);
    }
  }, [id]);

  useEffect(() => { loadVisits(0, false); }, [loadVisits]);

  if (error && error.status === 404) return <EmptyState title={P.notFound} icon="👤" />;
  if (error && !profile) return <ErrorBanner error={error} />;
  if (!profile) return <LoadingBlock />;

  const { visitor, stats } = profile;

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => navigate(-1)} className="text-sm font-semibold text-brand-700 hover:underline">
        {P.back}
      </button>

      <section className="card flex flex-wrap items-center gap-4 p-4">
        <PhotoThumb filename={profile.photo_path} alt={visitor.full_name} size="h-24 w-24" onOpen={lightbox.open} />
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-bold text-slate-900">{visitor.full_name}</h2>
          {visitor.phone ? (
            <a href={`tel:${visitor.phone}`} className="text-brand-700 hover:underline">{visitor.phone}</a>
          ) : (
            <p className="text-slate-500">{L.console.people.noPhone}</p>
          )}
          <p className="mt-1 text-sm text-slate-500">
            {P.firstSeen} {formatDateTime(stats.first_visit_at)} · {P.lastSeen} {formatDateTime(stats.last_visit_at)}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label={P.totalVisits} value={stats.visits.value} drill={stats.visits.drill} />
        <StatTile label={P.turnedAway} value={stats.rejected.value} drill={stats.rejected.value ? stats.rejected.drill : null} />
        <StatTile label={P.broughtMembers} value={stats.companions} />
      </section>

      <section className="grid gap-5 sm:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 font-bold text-slate-800">{P.cameToSee}</h3>
          <div className="flex flex-wrap gap-2">
            {profile.hosts.map((h) => (
              <Link key={h.label} to={drillHref(h.visits.drill)}
                    className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-brand-50 hover:text-brand-800">
                {h.label} <span className="font-semibold">{fmtNum(h.visits.value)}</span>
              </Link>
            ))}
          </div>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 font-bold text-slate-800">{P.cameFrom}</h3>
          <div className="flex flex-wrap gap-2">
            {profile.from.map((f) => (
              <Link key={`${f.from_type}-${f.label}`} to={drillHref(f.visits.drill)}
                    className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700 hover:bg-brand-50 hover:text-brand-800">
                {f.label || D.fromTypes[f.from_type]}
                {f.label && <span className="text-slate-400"> · {D.fromTypes[f.from_type]}</span>}{' '}
                <span className="font-semibold">{fmtNum(f.visits.value)}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-bold text-slate-800">{P.history}</h3>
        {visits.map((v) => <VisitRow key={v.id} visit={v} onOpenPhoto={lightbox.open} linkPerson={false} />)}
        {loadingVisits && visits.length === 0 && <LoadingBlock />}
        {visits.length < total && (
          <button type="button" className="btn-ghost w-full" disabled={loadingVisits} onClick={() => loadVisits(offset + PAGE, true)}>
            {loadingVisits ? <Spinner className="h-5 w-5" /> : L.console.visits.loadMore}
          </button>
        )}
      </section>

      <Lightbox photo={lightbox.photo} onClose={lightbox.close} />
    </div>
  );
}
