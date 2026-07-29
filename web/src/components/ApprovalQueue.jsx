import { useCallback, useState } from 'react';
import L from '../labels';
import { approvals } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useLiveEvent } from '../lib/live';
import { formatTime, formatDuration } from '../lib/format';
import {
  StatusBadge, PhotoThumb, Lightbox, useLightbox, LoadingBlock,
  EmptyState, ErrorBanner, Spinner, Modal, Toast,
} from './ui';

const POLL_MS = 15000;

function Row({ label, children }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="shrink-0 text-slate-500">{label}:</span>
      <span className="min-w-0 font-medium text-slate-800">{children}</span>
    </div>
  );
}

function PendingCard({ visit, onDecide, busy, onOpenPhoto }) {
  return (
    <div className={`card overflow-hidden ${visit.unattended ? 'border-2 border-amber-400' : ''}`}>
      {visit.unattended && (
        <p className="bg-amber-100 px-4 py-1.5 text-sm font-bold text-amber-900">
          ⚠ {L.approvals.unattended} — {L.approvals.unattendedNote}
        </p>
      )}

      <div className="flex gap-3 p-4">
        <PhotoThumb filename={visit.photo_path} alt={visit.full_name} size="h-24 w-24" onOpen={onOpenPhoto} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-lg font-bold">{visit.full_name}</p>
          {visit.phone && (
            <a href={`tel:+91${visit.phone}`} className="inline-block font-medium text-brand-600 underline">
              {visit.phone} <span className="text-xs text-slate-500">({L.approvals.tapToCall})</span>
            </a>
          )}
          {visit.from_display && <Row label={L.gate.from.label}>{visit.from_display}</Row>}
          <Row label={L.gate.visiting}>{visit.host_display}</Row>
          {visit.purpose && <Row label={L.gate.purpose}>{visit.purpose}</Row>}
          <Row label={L.approvals.loggedBy}>
            {visit.logged_by_name} · {formatTime(visit.created_at)}
          </Row>
          <p className={`text-sm font-semibold ${visit.unattended ? 'text-amber-700' : 'text-slate-500'}`}>
            {L.approvals.waitingFor(formatDuration(visit.waiting_seconds))}
          </p>
        </div>
      </div>

      {visit.companion_count > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-slate-600">
            {L.gate.membersWith(visit.companion_count)}
          </p>
          <div className="flex flex-wrap gap-3">
            {visit.companions.map((c) => (
              <div key={c.id} className="w-16 text-center">
                <PhotoThumb filename={c.photo_path} alt={c.name} size="h-16 w-16" onOpen={onOpenPhoto} />
                <p className="mt-1 truncate text-xs text-slate-600">{c.name}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex border-t border-slate-200">
        <button
          type="button"
          onClick={() => onDecide(visit, 'reject')}
          disabled={busy}
          className="flex-1 bg-red-600 py-4 text-lg font-bold text-white active:bg-red-700 disabled:opacity-60"
        >
          {busy === 'reject' ? <Spinner className="mx-auto h-5 w-5 text-white" /> : L.approvals.reject}
        </button>
        <button
          type="button"
          onClick={() => onDecide(visit, 'approve')}
          disabled={busy}
          className="flex-[2] bg-green-600 py-4 text-lg font-bold text-white active:bg-green-700 disabled:opacity-60"
        >
          {busy === 'approve' ? <Spinner className="mx-auto h-5 w-5 text-white" /> : L.approvals.approve}
        </button>
      </div>
    </div>
  );
}

function HistoryCard({ visit, onOpenPhoto }) {
  return (
    <div className="card flex gap-3 p-3">
      <PhotoThumb filename={visit.photo_path} alt={visit.full_name} size="h-16 w-16" onOpen={onOpenPhoto} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{visit.full_name}</p>
        <p className="truncate text-sm text-slate-600">
          {L.gate.visiting}: {visit.host_display}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge status={visit.status} />
          <span className="text-sm text-slate-500">{formatTime(visit.decision_at)}</span>
        </div>
        {visit.rejection_reason && (
          <p className="mt-1 text-sm text-slate-600">
            {L.gate.reason}: {visit.rejection_reason}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The shared approval queue. Rendered both as the admin's whole screen and as a
 * tab inside the superadmin console — same data, same actions, one implementation.
 */
export default function ApprovalQueue({ onCountChange }) {
  const [tab, setTab] = useState('pending');
  const [busy, setBusy] = useState({});
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState(null);
  const lightbox = useLightbox();

  const fetchPending = useCallback(async () => {
    const result = await approvals.pending();
    if (onCountChange) onCountChange(result.count);
    return result;
  }, [onCountChange]);

  const pending = usePoll(fetchPending, POLL_MS, []);
  const history = usePoll(approvals.history, 60000, []);

  // Real-time: refresh the queue the instant the server says it changed, instead
  // of waiting for the next poll. Polling above remains the fallback.
  useLiveEvent('approvals_changed', () => {
    pending.reload({ silent: true }).catch(() => {});
    history.reload({ silent: true }).catch(() => {});
  });

  const decide = useCallback(
    async (visit, kind, withReason) => {
      setBusy((b) => ({ ...b, [visit.id]: kind }));
      try {
        await (kind === 'approve' ? approvals.approve(visit.id) : approvals.reject(visit.id, withReason));
      } catch (err) {
        // 409 = another admin got there first. That is a normal outcome of a
        // broadcast queue, so show who decided rather than an error.
        setToast(
          err.status === 409
            ? { message: err.message || L.approvals.decidedElsewhere, tone: 'info' }
            : { message: err.message, tone: 'error' }
        );
      } finally {
        setBusy((b) => {
          const next = { ...b };
          delete next[visit.id];
          return next;
        });
        pending.reload({ silent: true }).catch(() => {});
        history.reload({ silent: true }).catch(() => {});
      }
    },
    [pending, history]
  );

  const onDecide = (visit, kind) => {
    if (kind === 'reject') {
      setReason('');
      setRejecting(visit);
      return;
    }
    decide(visit, 'approve');
  };

  const visits = (pending.data && pending.data.visits) || [];
  const historyVisits = (history.data && history.data.visits) || [];

  const tabBtn = (key, label, badge) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={`flex-1 border-b-4 px-3 py-3 font-semibold ${
        tab === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500'
      }`}
    >
      {label}
      {badge > 0 && (
        <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-sm font-bold text-white">{badge}</span>
      )}
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex border-b border-slate-200 bg-white">
        {tabBtn('pending', L.approvals.pending, visits.length)}
        {tabBtn('history', L.approvals.history, 0)}
      </div>

      {tab === 'pending' ? (
        <div className="space-y-3">
          {pending.error && !pending.data && (
            <ErrorBanner error={pending.error} onRetry={() => pending.reload()} />
          )}
          {pending.loading && !pending.data ? (
            <LoadingBlock />
          ) : visits.length === 0 ? (
            <EmptyState title={L.approvals.noPending} hint={L.approvals.noPendingHint} icon="✅" />
          ) : (
            visits.map((v) => (
              <PendingCard
                key={v.id}
                visit={v}
                onDecide={onDecide}
                busy={busy[v.id]}
                onOpenPhoto={lightbox.open}
              />
            ))
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {history.loading && !history.data ? (
            <LoadingBlock />
          ) : historyVisits.length === 0 ? (
            <EmptyState title={L.approvals.noHistory} icon="📋" />
          ) : (
            historyVisits.map((v) => <HistoryCard key={v.id} visit={v} onOpenPhoto={lightbox.open} />)
          )}
        </div>
      )}

      {rejecting && (
        <Modal
          title={L.approvals.rejectTitle}
          onClose={() => setRejecting(null)}
          footer={
            <div className="flex gap-3">
              <button type="button" className="btn-ghost flex-1" onClick={() => setRejecting(null)}>
                {L.cancel}
              </button>
              <button
                type="button"
                className="btn-reject flex-1"
                onClick={() => {
                  const visit = rejecting;
                  setRejecting(null);
                  decide(visit, 'reject', reason.trim() || undefined);
                }}
              >
                {L.approvals.confirmReject}
              </button>
            </div>
          }
        >
          <p className="mb-3 font-semibold">{rejecting.full_name}</p>
          <label className="label" htmlFor="reject-reason">{L.approvals.rejectReason}</label>
          <textarea
            id="reject-reason"
            className="field"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={L.approvals.rejectReasonPlaceholder}
          />
        </Modal>
      )}

      <Lightbox photo={lightbox.photo} onClose={lightbox.close} />
      <Toast message={toast && toast.message} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
