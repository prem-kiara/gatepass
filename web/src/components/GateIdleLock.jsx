import { useCallback, useEffect, useRef, useState } from 'react';
import L from '../labels';
import { useAuth } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { Spinner } from './ui';
import PinPad from './PinPad';

const IDLE_MS = 10 * 60 * 1000;
const PIN_LENGTH = 6;

/**
 * Locks the shared gate phone after a few idle minutes.
 *
 * A guard's 12-hour session is convenient across a shift but means an
 * unattended phone on the counter can log visitors under their name. This puts
 * the PIN back in front of that — the guard's own PIN, so whoever resumes is
 * still the person the audit trail will name.
 *
 * SECURITY only: an admin's phone is personal and already locks itself.
 */
export default function GateIdleLock() {
  const { user, logout } = useAuth();
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const active = user && user.role === 'SECURITY';

  const resetTimer = useCallback(() => {
    if (!active || locked) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLocked(true), IDLE_MS);
  }, [active, locked]);

  useEffect(() => {
    if (!active) return undefined;
    const events = ['touchstart', 'mousedown', 'keydown', 'scroll'];
    events.forEach((e) => window.addEventListener(e, resetTimer, { passive: true }));
    resetTimer();
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetTimer));
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, resetTimer]);

  // Unlocking is a real re-authentication, not a client-side flag: it refreshes
  // the session and would fail for anyone who is not this guard.
  //
  // The in-flight guard is a ref, not state: `busy` as a dependency would make
  // setBusy(true) re-run this effect, and the re-run's cleanup would cancel the
  // request that is still in flight — leaving a wrong PIN spinning forever
  // instead of saying so.
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!locked || pin.length !== PIN_LENGTH || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        await authApi.loginPin(user.id, pin);
        setLocked(false);
        setPin('');
        resetTimer();
      } catch (err) {
        setError(err.message || L.gateLock.wrongPin);
        setPin('');
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    })();
  }, [pin, locked, user, resetTimer]);

  if (!active || !locked) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-brand-900 px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-2xl">🔒</div>
          <h1 className="text-2xl font-bold">{L.gateLock.title}</h1>
          <p className="mt-1 text-sm text-brand-100">{L.gateLock.why}</p>
        </div>
        <div className="card p-6">
          <p className="text-center text-lg font-bold text-slate-800">{L.gateLock.signedInAs(user.name)}</p>
          <p className="mb-4 text-center text-sm text-slate-500">{L.gateLock.enterPin}</p>
          {error && (
            <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-center text-sm font-medium text-red-700">{error}</p>
          )}
          <PinPad value={pin} onChange={setPin} length={PIN_LENGTH} disabled={busy} />
          <div className="mt-4 flex h-6 items-center justify-center">
            {busy && <Spinner className="h-6 w-6 text-brand-600" />}
          </div>
          <button
            type="button"
            onClick={logout}
            className="w-full rounded-xl py-3 text-sm font-semibold text-slate-500 hover:bg-slate-50"
          >
            {L.gateLock.switchUser}
          </button>
        </div>
      </div>
    </div>
  );
}
