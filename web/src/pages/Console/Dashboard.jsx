import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import L from '../../labels';
import { admin } from '../../lib/api';
import { useLiveEvent } from '../../lib/live';
import { drillHref, personHref } from '../../lib/drill';
import { formatDateTime, formatDuration } from '../../lib/format';
import { LoadingBlock, ErrorBanner, PhotoImage } from '../../components/ui';
import { StatTile, ChartCard, DrillTable, BarList, ColumnChart, Heatmap, fmtNum, fmtDay } from '../../components/viz';

const D = L.console.dash;
const PRESETS = ['today', '7d', '30d', '90d', 'month', 'all'];
const REFRESH_MS = 60000;

/** "▲ 12 (+18%)" against the previous equal-length period. Neutral ink: more
 *  visitors is neither good nor bad, so no status colour. */
function delta(value, previous) {
  if (previous === null || previous === undefined) return null;
  const diff = value - previous;
  const pct = previous > 0 ? `${diff >= 0 ? '+' : ''}${Math.round((diff / previous) * 100)}%` : null;
  return `${D.delta(diff, pct)} ${D.vsPrevious}`;
}

/* ------------------------------------------------------------- range bar */

function RangeBar({ params, onChange, range }) {
  const [from, setFrom] = useState(params.from || '');
  const [to, setTo] = useState(params.to || '');
  const custom = params.preset === 'custom';

  return (
    <div className="relative flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange({ preset: p })}
          aria-pressed={params.preset === p}
          className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${
            params.preset === p ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
          }`}
        >
          {D.presets[p]}
        </button>
      ))}
      <details open={custom || undefined}>
        <summary
          className={`cursor-pointer list-none rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 ${
            custom ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
          }`}
        >
          {D.presets.custom}
        </summary>
        <div className="absolute left-0 top-full z-30 mt-2 flex w-[min(22rem,calc(100vw-2rem))] flex-wrap items-end gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lg">
          <input type="date" className="field min-w-0 flex-1 !py-1.5 text-sm" value={from} max={to || range?.today}
                 onChange={(e) => setFrom(e.target.value)} aria-label={L.console.visits.from} />
          <input type="date" className="field min-w-0 flex-1 !py-1.5 text-sm" value={to} min={from || undefined} max={range?.today}
                 onChange={(e) => setTo(e.target.value)} aria-label={L.console.visits.to} />
          <button type="button" className="btn-primary !py-1.5 text-sm" disabled={!from || !to}
                  onClick={() => onChange({ preset: 'custom', from, to })}>
            {D.apply}
          </button>
        </div>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------ dashboard */

export default function Dashboard() {
  const [sp, setSp] = useSearchParams();
  const preset = sp.get('preset') || '30d';
  const params = preset === 'custom' ? { preset, from: sp.get('from') || '', to: sp.get('to') || '' } : { preset };
  const key = JSON.stringify(params);

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  // Only the newest request may paint: switching ranges quickly must never let
  // a slow, older response overwrite the period you are looking at.
  const load = useCallback(async (silent) => {
    const ticket = ++latest.current;
    if (!silent) setLoading(true);
    try {
      const result = await admin.insights(JSON.parse(key));
      if (ticket === latest.current) { setData(result); setError(null); }
    } catch (err) {
      if (ticket === latest.current) setError(err);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    load(false);
    const t = setInterval(() => !document.hidden && load(true), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  // A decision or a new request changes the numbers — refresh without flicker.
  useLiveEvent('approvals_changed', () => load(true));

  const setRange = (next) => setSp(next, { replace: false });

  if (!data && loading) return <LoadingBlock />;
  if (!data && error) return <ErrorBanner error={error} onRetry={() => load(false)} />;
  if (!data) return null;

  const { totals: t, range } = data;
  const rangeText = D.rangeLabel(fmtDay(range.from, true), fmtDay(range.to, true));

  return (
    // Refetch keeps the frame: the previous render dims instead of vanishing.
    <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
      <div className="space-y-2">
        <RangeBar params={params} onChange={setRange} range={range} />
        <p className="text-sm text-slate-500">
          <span className="font-semibold text-slate-700">{rangeText}</span>
          {range.previous && ` · ${D.comparedWith(range.days)}`}
          <span className="hidden sm:inline"> · {D.tapHint}</span>
        </p>
      </div>
      {error && <ErrorBanner error={error} onRetry={() => load(false)} />}

      {/* Right now — independent of the range. */}
      <section className="card px-4 py-3 sm:flex sm:items-center sm:gap-6">
        <div className="shrink-0">
          <p className="text-sm font-bold text-slate-800">{D.rightNow}</p>
          <p className="text-xs text-slate-400">{D.rightNowHint}</p>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 sm:mt-0 sm:flex sm:gap-6">
          {[
            ['inside_now', D.insideNow],
            ['waiting', D.waiting],
            ['unattended', D.unattended],
          ].map(([k, label]) => (
            <Link key={k} to={drillHref(data.live[k].drill)}
                  className="rounded-lg px-2 py-1 text-center hover:bg-slate-50 sm:text-left">
              <span className="block text-2xl font-semibold text-slate-900 sm:inline">{fmtNum(data.live[k].value)}</span>{' '}
              <span className="block text-xs leading-tight text-slate-600 sm:inline sm:text-sm">{label}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Headline numbers. Exactly one hero figure per view. */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <StatTile hero label={D.visits} value={t.visits.value} drill={t.visits.drill}
                  delta={delta(t.visits.value, t.visits.previous)} />
        <StatTile label={D.people} value={t.people.value} drill={t.people.drill}
                  delta={delta(t.people.value, t.people.previous)} hint={D.peopleHint} />
        <StatTile label={D.uniqueVisitors} value={t.unique_visitors.value} drill={t.unique_visitors.drill}
                  delta={delta(t.unique_visitors.value, t.unique_visitors.previous)} hint={D.uniqueHint} />
        <StatTile label={D.repeatVisitors} value={t.repeat_visitors.value} drill={t.repeat_visitors.drill} />
        <StatTile label={D.approved} value={t.approved.value} drill={t.approved.drill} />
        <StatTile label={D.rejected} value={t.rejected.value} drill={t.rejected.drill} />
        <StatTile
          label={D.medianWait}
          display={t.median_decision.seconds === null ? D.noWait : formatDuration(t.median_decision.seconds)}
          drill={t.median_decision.drill}
          hint={D.medianWaitHint}
        />
        {t.pending.value > 0 && <StatTile label={D.pending} value={t.pending.value} drill={t.pending.drill} />}
      </section>

      {t.visits.value === 0 ? (
        <p className="card p-6 text-center text-slate-500">{D.empty}</p>
      ) : (
        <>
          <ChartCard
            title={range.bucket === 'week' ? D.perWeek : D.perDay}
            table={
              <DrillTable
                columns={[D.date, D.people, D.visits]}
                rows={data.series.map((b) => ({
                  key: b.start,
                  cells: [b.start === b.end ? fmtDay(b.start, true) : `${fmtDay(b.start)} – ${fmtDay(b.end, true)}`, fmtNum(b.people), fmtNum(b.visits.value)],
                  drill: b.visits.drill,
                }))}
              />
            }
          >
            <ColumnChart buckets={data.series} bucket={range.bucket} />
          </ChartCard>

          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard
              title={D.whenTitle}
              hint={D.whenHint}
              table={
                <DrillTable
                  columns={[D.date, D.visits]}
                  rows={[...data.heatmap]
                    .sort((a, b) => a.dow - b.dow || a.hour - b.hour)
                    .map((c) => ({
                      key: `${c.dow}-${c.hour}`,
                      cells: [`${D.weekdaysLong[c.dow]} ${D.hourRange(c.hour)}`, fmtNum(c.visits.value)],
                      drill: c.visits.drill,
                    }))}
                />
              }
            >
              <Heatmap cells={data.heatmap} />
            </ChartCard>

            <ChartCard title={D.fromTitle}>
              <BarList
                items={data.from_types
                  .filter((f) => f.visits.value > 0)
                  .map((f) => ({ key: f.from_type, label: D.fromTypes[f.from_type], value: f.visits.value, drill: f.visits.drill }))}
                empty={D.empty}
              />
              <h4 className="mb-1 mt-4 text-sm font-semibold text-slate-600">{D.topOrgs}</h4>
              <BarList
                items={data.organisations.top.map((o) => ({
                  key: `${o.from_type}-${o.label}`,
                  label: o.label,
                  sublabel: D.fromTypes[o.from_type],
                  value: o.visits.value,
                  drill: o.visits.drill,
                }))}
                empty={D.noOrgs}
              />
              {data.organisations.distinct > data.organisations.top.length && (
                <p className="mt-2 px-2 text-xs text-slate-500">
                  {D.moreOrgs(data.organisations.distinct - data.organisations.top.length)}
                </p>
              )}
            </ChartCard>

            <ChartCard title={D.hostsTitle}>
              <BarList
                items={data.hosts.map((h) => ({
                  key: `${h.is_staff ? 's' : 'n'}-${h.label}`,
                  label: h.label,
                  sublabel: h.is_staff ? null : D.notStaff,
                  value: h.visits.value,
                  drill: h.visits.drill,
                }))}
                empty={D.empty}
              />
            </ChartCard>

            <ChartCard title={D.decidersTitle}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-1.5 pr-3 font-semibold">{D.decider}</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">{D.approved}</th>
                      <th className="py-1.5 pr-3 text-right font-semibold">{D.rejected}</th>
                      <th className="py-1.5 text-right font-semibold">{D.typicalWait}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.deciders.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 pr-3">
                          <Link to={drillHref(d.total.drill)} className="font-semibold text-slate-800 hover:text-brand-700 hover:underline">
                            {d.name}
                          </Link>
                          <span className="block text-xs text-slate-400">{L.role[d.role]} · {D.visitsCount(d.total.value)}</span>
                        </td>
                        {['approved', 'rejected'].map((k) => (
                          <td key={k} className="py-2 pr-3 text-right tabular-nums">
                            {d[k].value > 0 ? (
                              <Link to={drillHref(d[k].drill)} className="font-semibold text-brand-700 hover:underline">{fmtNum(d[k].value)}</Link>
                            ) : <span className="text-slate-400">0</span>}
                          </td>
                        ))}
                        <td className="py-2 text-right tabular-nums text-slate-600">
                          {d.median_seconds === null ? '—' : formatDuration(d.median_seconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            <ChartCard title={D.regularsTitle} hint={D.regularsHint}>
              {data.frequent.length === 0 ? (
                <p className="py-4 text-sm text-slate-500">{D.noRegulars}</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {data.frequent.map((p) => (
                    <li key={p.visitor_id} className="flex items-center gap-3 py-2">
                      <Link to={personHref(p.visitor_id)} className="flex min-w-0 flex-1 items-center gap-3 hover:underline">
                        <PhotoImage filename={p.photo_path} alt={p.full_name} size="h-11 w-11" />
                        <span className="min-w-0">
                        <span className="block truncate font-semibold text-slate-800">{p.full_name}</span>
                        <span className="block text-xs text-slate-500">{D.lastSeen} {formatDateTime(p.last_visit_at)}</span>
                        </span>
                      </Link>
                      <Link to={drillHref(p.visits.drill)} className="shrink-0 text-sm font-semibold text-brand-700 hover:underline">
                        {D.visitsCount(p.visits.value)}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to={drillHref(t.unique_visitors.drill)} className="mt-2 inline-block text-sm font-semibold text-brand-700 hover:underline">
                {D.seeAllPeople}
              </Link>
            </ChartCard>

            <ChartCard title={D.guardsTitle}>
              <BarList
                items={data.guards.map((g) => ({ key: g.id, label: g.name, value: g.visits.value, drill: g.visits.drill }))}
                empty={D.empty}
              />
            </ChartCard>
          </div>

          <section className="card p-4">
            <h3 className="mb-3 font-bold text-slate-800">{D.latestTitle}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
              {data.latest.map((v) => (
                <Link key={v.id} to={personHref(v.visitor_id)} className="group rounded-xl p-1 text-center hover:bg-slate-50">
                  <span className="mx-auto block w-fit">
                    <PhotoImage filename={v.photo_path} alt={v.full_name} size="h-16 w-16" />
                  </span>
                  <span className="mt-1 block truncate text-sm font-semibold text-slate-800 group-hover:underline">{v.full_name}</span>
                  <span className="block truncate text-xs text-slate-500">{formatDateTime(v.created_at)}</span>
                </Link>
              ))}
            </div>
          </section>
        </>
      )}

      {/* The gate's unfinished records, for the selected period. */}
      <section className="card p-4">
        <h3 className="font-bold text-slate-800">{D.attentionTitle}</h3>
        <p className="mb-3 text-sm text-slate-500">{D.attentionHint}</p>
        {data.attention.never_checked_in.value + data.attention.auto_checked_out.value === 0 ? (
          <p className="text-sm text-slate-600">{D.allClear}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <StatTile label={D.neverCheckedIn} value={data.attention.never_checked_in.value} drill={data.attention.never_checked_in.drill} />
            <StatTile label={D.autoCheckedOut} value={data.attention.auto_checked_out.value} drill={data.attention.auto_checked_out.drill} />
          </div>
        )}
      </section>
    </div>
  );
}
