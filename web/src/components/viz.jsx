import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import L from '../labels';
import { drillHref } from '../lib/drill';

/**
 * Dashboard building blocks.
 *
 * Every mark is a real link to the visits behind it, so tapping, clicking,
 * keyboard (Tab + Enter) and "open in new tab" all drill down. Hover and focus
 * show the same tooltip; tooltips only ever repeat what the table view shows.
 *
 * Colours come from the validated `.viz` tokens in index.css; text always uses
 * text colours, never the series colour.
 */

const nf = new Intl.NumberFormat('en-IN');
export const fmtNum = (n) => (n === null || n === undefined ? '—' : nf.format(n));

/** "12 Aug" from a YYYY-MM-DD date, without a timezone shift. */
export function fmtDay(iso, withYear = false) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500';

/* ------------------------------------------------------------------ tooltip */

function useTooltip() {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const show = (e, content) => {
    if (!ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const t = e.currentTarget.getBoundingClientRect();
    // Keep the bubble inside the card rather than letting it hang off an edge.
    const x = Math.min(Math.max(t.left + t.width / 2 - box.left, 70), box.width - 70);
    setTip({ ...content, x, y: t.top - box.top });
  };
  const hide = () => setTip(null);
  return { ref, tip, show, hide };
}

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-slate-900 px-3 py-2 text-left shadow-lg"
      style={{ left: tip.x, top: tip.y - 8 }}
    >
      {/* Value leads, label follows. */}
      <p className="text-sm font-semibold text-white">{tip.value}</p>
      <p className="text-xs text-slate-300">{tip.label}</p>
    </div>
  );
}

/* --------------------------------------------------------------- stat tile */

export function StatTile({ label, value, display, drill, delta, hint, hero = false }) {
  const body = (
    <>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className={`mt-1 font-semibold text-slate-900 ${hero ? 'text-5xl' : 'text-3xl'}`}>
        {display !== undefined ? display : fmtNum(value)}
      </p>
      {delta && <p className="mt-1 text-sm text-slate-500">{delta}</p>}
      {hint && <p className="mt-1 text-xs leading-snug text-slate-400">{hint}</p>}
    </>
  );
  const cls = `card block p-4 text-left ${hero ? 'sm:col-span-2 lg:row-span-2 flex flex-col justify-center' : ''}`;
  if (!drill) return <div className={cls}>{body}</div>;
  return (
    <Link to={drillHref(drill)} className={`${cls} transition hover:border-brand-300 hover:shadow-md ${focusRing}`}>
      {body}
    </Link>
  );
}

/* ---------------------------------------------------------------- card */

export function ChartCard({ title, hint, table, children, className = '' }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card viz p-4 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bold text-slate-800">{title}</h3>
          {hint && <p className="text-sm text-slate-500">{hint}</p>}
        </div>
        {table && (
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            {asTable ? L.console.dash.showChart : L.console.dash.showTable}
          </button>
        )}
      </div>
      {asTable ? table : children}
    </section>
  );
}

/** The table twin of a chart — every value reachable without hovering. */
export function DrillTable({ columns, rows }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {columns.map((c) => (
              <th key={c} className="py-1.5 pr-3 font-semibold">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              {r.cells.map((cell, i) => (
                <td key={i} className={`py-1.5 pr-3 ${i === r.cells.length - 1 ? 'tabular-nums' : ''}`}>
                  {i === r.cells.length - 1 && r.drill ? (
                    <Link to={drillHref(r.drill)} className="font-semibold text-brand-700 hover:underline">{cell}</Link>
                  ) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------- horizontal bars */

/**
 * One series, one colour for every bar (nominal categories get no value ramp).
 * items: [{ key, label, sublabel?, value, drill }]
 */
export function BarList({ items, empty }) {
  if (!items.length) return <p className="py-4 text-sm text-slate-500">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-0.5">
      {items.map((i) => (
        <li key={i.key}>
          <Link
            to={drillHref(i.drill)}
            className={`group block rounded-lg px-2 py-1.5 hover:bg-slate-50 ${focusRing}`}
            aria-label={`${i.label}: ${i.value}`}
          >
            <span className="block truncate text-sm text-slate-700">
              {i.label}
              {i.sublabel && <span className="text-slate-400"> · {i.sublabel}</span>}
            </span>
            <span className="mt-1 flex items-center gap-2">
              {/* Thin bar, 4px rounded data end, square at the baseline. */}
              <span
                className="block h-2.5 rounded-r-[4px] bg-[var(--viz-series-1)] group-hover:bg-[var(--viz-series-1-hover)]"
                style={{ width: `${(i.value / max) * 85}%`, minWidth: i.value > 0 ? 3 : 0 }}
              />
              <span className="text-sm font-semibold tabular-nums text-slate-900">{fmtNum(i.value)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------ column chart */

function niceMax(max) {
  if (max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => max / s <= 4) || pow * 10;
  return Math.ceil(max / step) * step;
}

/** Visits per day (or week): one series, one axis, every column a drill-down. */
export function ColumnChart({ buckets, bucket }) {
  const { ref, tip, show, hide } = useTooltip();
  const max = Math.max(0, ...buckets.map((b) => b.visits.value));
  const top = niceMax(max);
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const peak = buckets.reduce((best, b, i) => (b.visits.value > (buckets[best]?.visits.value ?? -1) ? i : best), 0);
  const H = 160;

  const describe = (b) =>
    bucket === 'week' ? `${fmtDay(b.start)} – ${fmtDay(b.end)}` : new Date(`${b.start}T00:00:00Z`)
      .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <div ref={ref} className="relative">
      <div className="flex">
        {/* y-axis ticks: clean numbers only */}
        <div className="relative mr-2 w-7 shrink-0 text-right text-xs tabular-nums text-[var(--viz-muted)]" style={{ height: H }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: H - (t / top) * H }}>{fmtNum(t)}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: H }}>
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className={`absolute inset-x-0 h-px ${t === 0 ? 'bg-[var(--viz-axis)]' : 'bg-[var(--viz-grid)]'}`}
              style={{ top: H - (t / top) * H }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {buckets.map((b, i) => {
              const h = top ? (b.visits.value / top) * H : 0;
              const label = `${describe(b)} · ${L.console.dash.peopleCount(b.people)}`;
              return (
                <Link
                  key={b.start}
                  to={drillHref(b.visits.drill)}
                  aria-label={`${describe(b)}: ${b.visits.value} ${L.console.dash.visits.toLowerCase()}`}
                  onPointerEnter={(e) => show(e, { value: L.console.dash.visitsCount(b.visits.value), label })}
                  onFocus={(e) => show(e, { value: L.console.dash.visitsCount(b.visits.value), label })}
                  onPointerLeave={hide}
                  onBlur={hide}
                  // The whole column is the hit target, not just the painted bar.
                  className={`group relative flex h-full min-w-0 flex-1 items-end justify-center ${focusRing}`}
                >
                  {i === peak && b.visits.value > 0 && (
                    <span className="absolute text-xs font-semibold text-[var(--viz-ink-2)]" style={{ bottom: h + 2 }}>
                      {fmtNum(b.visits.value)}
                    </span>
                  )}
                  <span
                    className="block w-full max-w-[24px] rounded-t-[4px] bg-[var(--viz-series-1)] group-hover:bg-[var(--viz-series-1-hover)]"
                    style={{ height: b.visits.value > 0 ? Math.max(h, 2) : 0 }}
                  />
                </Link>
              );
            })}
          </div>
        </div>
      </div>
      <div className="ml-9 mt-1 flex gap-[2px] text-[11px] text-[var(--viz-muted)]">
        {buckets.map((b, i) => (
          <span key={b.start} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
            {i % labelEvery === 0 ? fmtDay(b.start) : ''}
          </span>
        ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/* ----------------------------------------------------------------- heatmap */

const SEQ = ['var(--viz-seq-1)', 'var(--viz-seq-2)', 'var(--viz-seq-3)', 'var(--viz-seq-4)', 'var(--viz-seq-5)'];

/** Weekday x hour of arrival; one hue, darker = busier. */
export function Heatmap({ cells }) {
  const { ref, tip, show, hide } = useTooltip();
  const D = L.console.dash;
  const byKey = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const hoursWithData = cells.map((c) => c.hour);
  const minH = Math.min(8, ...hoursWithData);
  const maxH = Math.max(19, ...hoursWithData);
  const hours = [];
  for (let h = minH; h <= maxH; h += 1) hours.push(h);
  const max = Math.max(1, ...cells.map((c) => c.visits.value));
  const bin = (v) => SEQ[Math.min(SEQ.length - 1, Math.ceil((v / max) * SEQ.length) - 1)];

  return (
    <div ref={ref} className="relative">
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div className="ml-10 flex gap-[2px] text-[11px] text-[var(--viz-muted)]">
            {hours.map((h) => (
              <span key={h} className="flex-1 text-center">{h % 2 === 0 ? String(h).padStart(2, '0') : ''}</span>
            ))}
          </div>
          {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
            <div key={dow} className="mt-[2px] flex items-center gap-[2px]">
              <span className="w-10 shrink-0 text-xs text-[var(--viz-ink-2)]">{D.weekdays[dow]}</span>
              {hours.map((h) => {
                const c = byKey.get(`${dow}-${h}`);
                const v = c ? c.visits.value : 0;
                const content = { value: D.visitsCount(v), label: `${D.weekdaysLong[dow]} ${D.hourRange(h)}` };
                if (!c) {
                  return <span key={h} aria-hidden="true" className="h-7 flex-1 rounded-[3px] bg-[var(--viz-empty)]" />;
                }
                return (
                  <Link
                    key={h}
                    to={drillHref(c.visits.drill)}
                    aria-label={`${content.label}: ${content.value}`}
                    onPointerEnter={(e) => show(e, content)}
                    onFocus={(e) => show(e, content)}
                    onPointerLeave={hide}
                    onBlur={hide}
                    className={`h-7 flex-1 rounded-[3px] transition hover:ring-2 hover:ring-slate-900/40 ${focusRing}`}
                    style={{ background: bin(v) }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* Scale legend: sequential needs one. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--viz-ink-2)]">
        <span className="inline-block h-3 w-4 rounded-[3px] bg-[var(--viz-empty)]" /> {D.none}
        <span className="ml-3">{D.fewer}</span>
        {SEQ.map((c) => <span key={c} className="inline-block h-3 w-4 rounded-[3px]" style={{ background: c }} />)}
        <span>{D.more}</span>
        <span className="text-[var(--viz-muted)]">(max {fmtNum(max)})</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}
