import L from '../labels';

const TZ = 'Asia/Kolkata';

export function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

export function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: TZ,
  });
}

export function formatDateTime(value) {
  if (!value) return '';
  return `${formatDate(value)}, ${formatTime(value)}`;
}

/** Compact waiting time for approval cards: "just now", "7 min", "1 hr 20 min". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  if (s < 60) return L.time.justNow;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return L.time.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? L.time.hours(hours) : L.time.hoursMinutes(hours, rem);
}

/** Today's date as YYYY-MM-DD in gate-local time, for date inputs and CSV names. */
export function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

export const STATUS_STYLES = {
  PENDING: 'bg-amber-100 text-amber-900 border-amber-300',
  APPROVED: 'bg-green-100 text-green-900 border-green-300',
  REJECTED: 'bg-red-100 text-red-900 border-red-300',
  INSIDE: 'bg-blue-100 text-blue-900 border-blue-300',
  CHECKED_OUT: 'bg-slate-100 text-slate-700 border-slate-300',
};

export const STATUS_DOT = {
  PENDING: 'bg-amber-500',
  APPROVED: 'bg-green-600',
  REJECTED: 'bg-red-600',
  INSIDE: 'bg-blue-600',
  CHECKED_OUT: 'bg-slate-400',
};
