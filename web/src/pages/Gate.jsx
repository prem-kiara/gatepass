import { useCallback, useEffect, useState } from 'react';
import L from '../labels';
import { gate } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useLiveEvent } from '../lib/live';
import { formatTime, STATUS_DOT } from '../lib/format';
import AppHeader from '../components/AppHeader';
import NewVisitorFlow from '../components/NewVisitorFlow';
import {
  StatusBadge, PhotoThumb, Lightbox, useLightbox, LoadingBlock,
  EmptyState, ErrorBanner, Spinner, Toast,
} from '../components/ui';

const POLL_MS = 10000;

function VisitCard({ visit, onAction, busyId, onOpenPhoto }) {
  const busy = busyId === visit.id;
  const canCheckIn = visit.status === 'APPROVED';
  const canCheckOut = visit.status === 'INSIDE';

  return (
    <div className="card overflow-hidden">
      <div className="flex gap-3 p-3">
        <div className="relative">
          <PhotoThumb
            filename={visit.photo_path}
            alt={visit.full_name}
            size="h-20 w-20"
            onOpen={onOpenPhoto}
          />
          {visit.companion_count > 0 && (
            <span className="absolute -right-1.5 -top-1.5 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">
              {L.gate.memberCount(visit.companion_count)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-lg font-bold">{visit.full_name}</p>
            <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[visit.status]}`} aria-hidden="true" />
          </div>
          <p className="truncate text-sm text-slate-600">
            {L.gate.visiting}: <span className="font-medium">{visit.host_display}</span>
          </p>
          {visit.purpose && <p className="truncate text-sm text-slate-500">{visit.purpose}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StatusBadge status={visit.status} />
            <span className="text-sm text-slate-500">{formatTime(visit.created_at)}</span>
          </div>
        </div>
      </div>

      {(visit.status === 'REJECTED' || visit.status === 'APPROVED' || visit.status === 'INSIDE') &&
        visit.approved_by_name && (
          <p className="border-t border-slate-100 px-3 py-2 text-sm text-slate-600">
            {visit.status === 'REJECTED'
              ? L.gate.rejectedBy(visit.approved_by_name)
              : L.gate.approvedBy(visit.approved_by_name)}
            {visit.rejection_reason && ` — ${visit.rejection_reason}`}
          </p>
        )}

      {visit.status === 'PENDING' && (
        <p className="border-t border-amber-100 bg-amber-50 px-3 py-2.5 text-center font-semibold text-amber-800">
          ⏳ {L.gate.waitingApproval}
        </p>
      )}

      {(canCheckIn || canCheckOut) && (
        <button
          type="button"
          onClick={() => onAction(visit, canCheckIn ? 'in' : 'out')}
          disabled={busy}
          className={`w-full py-4 text-lg font-bold text-white ${
            canCheckIn ? 'bg-green-600 active:bg-green-700' : 'bg-slate-600 active:bg-slate-700'
          } disabled:opacity-60`}
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner className="h-5 w-5 text-white" />
              {canCheckIn ? L.gate.checkingIn : L.gate.checkingOut}
            </span>
          ) : canCheckIn ? (
            L.gate.checkIn
          ) : (
            L.gate.checkOut
          )}
        </button>
      )}
    </div>
  );
}

export default function Gate() {
  const [showFlow, setShowFlow] = useState(false);
  const [hosts, setHosts] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const lightbox = useLightbox();

  const { data, error, loading, reload } = usePoll(gate.today, POLL_MS, []);

  useEffect(() => {
    gate.hosts().then(({ hosts: h }) => setHosts(h)).catch(() => setHosts([]));
  }, []);

  const onAction = useCallback(
    async (visit, kind) => {
      setBusyId(visit.id);
      try {
        await (kind === 'in' ? gate.checkIn(visit.id) : gate.checkOut(visit.id));
      } catch (err) {
        // A 409 means another device already moved this visit — refreshing shows
        // the truth, which is more useful than an error the guard cannot act on.
        if (err.status !== 409) setToast({ message: err.message, tone: 'error' });
      } finally {
        setBusyId(null);
        reload({ silent: true }).catch(() => {});
      }
    },
    [reload]
  );

  // Real-time: the moment an admin approves/rejects (or a group is checked in/out
  // on another gate device), refresh — no waiting for the 10s poll.
  useLiveEvent('gate_changed', () => reload({ silent: true }).catch(() => {}));

  const visits = (data && data.visits) || [];

  return (
    <div className="min-h-screen pb-28">
      <AppHeader title={L.gate.title} />

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {error && !data && <ErrorBanner error={error} onRetry={() => reload()} />}

        <h2 className="text-lg font-bold text-slate-700">{L.gate.todaysVisitors}</h2>

        {loading && !data ? (
          <LoadingBlock />
        ) : visits.length === 0 ? (
          <EmptyState title={L.gate.noVisitors} hint={L.gate.noVisitorsHint} />
        ) : (
          <div className="space-y-3">
            {visits.map((v) => (
              <VisitCard
                key={v.id}
                visit={v}
                onAction={onAction}
                busyId={busyId}
                onOpenPhoto={lightbox.open}
              />
            ))}
          </div>
        )}
      </main>

      {/* Always reachable with a thumb, whatever is scrolled into view. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 p-4 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <button
            type="button"
            onClick={() => setShowFlow(true)}
            className="btn-primary w-full py-5 text-xl shadow-lg"
          >
            {L.gate.newVisitor}
          </button>
        </div>
      </div>

      {showFlow && (
        <NewVisitorFlow
          hosts={hosts}
          onClose={() => setShowFlow(false)}
          onCreated={() => {
            setShowFlow(false);
            setToast({ message: L.gate.sent, tone: 'success' });
            reload({ silent: true }).catch(() => {});
          }}
        />
      )}

      <Lightbox photo={lightbox.photo} onClose={lightbox.close} />
      <Toast message={toast && toast.message} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
