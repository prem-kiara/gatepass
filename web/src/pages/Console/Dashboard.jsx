import L from '../../labels';
import { admin } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { formatDateTime, formatDuration } from '../../lib/format';
import { LoadingBlock, ErrorBanner, EmptyState, StatusBadge } from '../../components/ui';

const CARDS = [
  { key: 'PENDING', label: L.console.dashboard.pending, tone: 'bg-amber-50 text-amber-900 border-amber-200' },
  { key: 'APPROVED', label: L.console.dashboard.approved, tone: 'bg-green-50 text-green-900 border-green-200' },
  { key: 'INSIDE', label: L.console.dashboard.inside, tone: 'bg-blue-50 text-blue-900 border-blue-200' },
  { key: 'CHECKED_OUT', label: L.console.dashboard.checkedOut, tone: 'bg-slate-50 text-slate-700 border-slate-200' },
  { key: 'REJECTED', label: L.console.dashboard.rejected, tone: 'bg-red-50 text-red-900 border-red-200' },
];

export default function Dashboard() {
  const { data, error, loading, reload } = usePoll(admin.dashboard, 30000, []);

  if (loading && !data) return <LoadingBlock />;
  if (error && !data) return <ErrorBanner error={error} onRetry={() => reload()} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-bold text-slate-700">{L.console.dashboard.title}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {CARDS.map((c) => (
            <div key={c.key} className={`rounded-2xl border p-4 ${c.tone}`}>
              <p className="text-3xl font-bold tabular-nums">{data.today[c.key] || 0}</p>
              <p className="text-sm font-semibold">{c.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-slate-600">
          {L.console.dashboard.totalVisits}: <span className="font-bold">{data.today_total}</span>
        </p>
      </section>

      {data.unattended_count > 0 && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 font-semibold text-amber-900">
          ⚠ {L.console.dashboard.unattended(data.unattended_count)}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-bold text-slate-700">{L.console.dashboard.perAdmin}</h2>
        {data.per_admin.length === 0 ? (
          <EmptyState title={L.console.dashboard.noDecisions} icon="📊" />
        ) : (
          <div className="card divide-y divide-slate-100">
            {data.per_admin.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{a.name}</p>
                  <p className="text-sm text-slate-500">{L.role[a.role]}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xl font-bold tabular-nums">{a.decisions}</p>
                  <p className="text-sm text-slate-500">
                    {a.approvals} {L.console.dashboard.approvalsLabel} · {a.rejections}{' '}
                    {L.console.dashboard.rejectionsLabel}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold text-slate-700">{L.console.dashboard.neverCheckedOut}</h2>
        {data.never_checked_out.length === 0 ? (
          <EmptyState title={L.console.dashboard.neverCheckedOutEmpty} icon="👍" />
        ) : (
          <div className="card divide-y divide-slate-100">
            {data.never_checked_out.map((v) => (
              <div key={v.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{v.full_name}</p>
                  <p className="text-sm text-slate-500">
                    {L.gate.checkIn}: {formatDateTime(v.checked_in_at)} · {formatDuration(v.waiting_seconds)}
                  </p>
                </div>
                <StatusBadge status={v.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
