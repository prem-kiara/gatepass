import { useEffect, useState } from 'react';
import L from '../labels';
import { photoUrl } from '../lib/api';
import { STATUS_STYLES } from '../lib/format';

export function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_STYLES[status] || STATUS_STYLES.CHECKED_OUT}`}>
      {L.status[status] || status}
    </span>
  );
}

export function Spinner({ className = 'h-6 w-6' }) {
  return (
    <svg className={`animate-spin text-brand-600 ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function LoadingBlock({ label = L.loading }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500">
      <Spinner className="h-8 w-8" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, hint, icon = '🚪' }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="text-4xl" aria-hidden="true">{icon}</span>
      <p className="text-lg font-semibold text-slate-700">{title}</p>
      {hint && <p className="text-slate-500">{hint}</p>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  const message = error.message === 'NETWORK' ? L.noConnection : error.message || L.somethingWrong;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-red-900"
    >
      <span className="font-medium">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-semibold underline">
          {L.retry}
        </button>
      )}
    </div>
  );
}

/** Tap-to-enlarge photo. Admins need to actually see the face before approving. */
export function PhotoThumb({ filename, alt, size = 'h-16 w-16', onOpen }) {
  if (!filename) {
    return <div className={`${size} shrink-0 rounded-xl bg-slate-200`} aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen && onOpen(filename, alt)}
      className={`${size} shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-100`}
      aria-label={alt}
    >
      <img src={photoUrl(filename)} alt={alt} className="h-full w-full object-cover" loading="lazy" />
    </button>
  );
}

export function Lightbox({ photo, onClose }) {
  useEffect(() => {
    if (!photo) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [photo, onClose]);

  if (!photo) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={photo.alt}
    >
      <img src={photoUrl(photo.filename)} alt={photo.alt} className="max-h-[80vh] max-w-full rounded-xl object-contain" />
      <p className="mt-4 text-lg font-semibold text-white">{photo.alt}</p>
      <button type="button" className="btn-ghost mt-4" onClick={onClose}>
        {L.close}
      </button>
    </div>
  );
}

/** Shared lightbox state — every screen showing photos uses this pair. */
export function useLightbox() {
  const [photo, setPhoto] = useState(null);
  return {
    photo,
    open: (filename, alt) => setPhoto({ filename, alt }),
    close: () => setPhoto(null),
  };
}

export function Modal({ title, children, onClose, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div className="card max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-b-none sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="p-2 text-2xl leading-none text-slate-500" aria-label={L.close}>
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="sticky bottom-0 border-t border-slate-200 bg-white px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Toast({ message, tone = 'success', onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [message, onDone]);

  if (!message) return null;
  const tones = {
    success: 'bg-green-700',
    error: 'bg-red-700',
    info: 'bg-slate-800',
  };
  return (
    <div
      role="status"
      className={`fixed inset-x-4 bottom-6 z-50 rounded-xl px-5 py-4 text-center font-semibold text-white shadow-lg sm:left-1/2 sm:right-auto sm:w-96 sm:-translate-x-1/2 ${tones[tone]}`}
    >
      {message}
    </div>
  );
}
