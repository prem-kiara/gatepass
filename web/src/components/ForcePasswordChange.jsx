import { useState } from 'react';
import L from '../labels';
import { useAuth } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { Spinner, ErrorBanner } from './ui';

/**
 * Shown when someone signs in with a one-time password issued by a superadmin.
 *
 * They cannot reach the app until they have replaced it — which is what stops
 * the reset from doubling as a working password somebody else knows. The API
 * enforces the same rule, so this screen is the courtesy, not the control.
 */
export default function ForcePasswordChange() {
  const { refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) return setError({ message: L.forcePassword.mismatch });
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      await refresh(); // clears must_change_password, App routes onward
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-2xl">🔑</div>
          <h1 className="text-2xl font-bold">{L.forcePassword.title}</h1>
          <p className="mt-1 text-sm text-brand-100">{L.forcePassword.why}</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <ErrorBanner error={error} />
          <div>
            <label className="label" htmlFor="fp-current">{L.forcePassword.current}</label>
            <input
              id="fp-current" type="password" className="field" value={current}
              onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required
            />
          </div>
          <div>
            <label className="label" htmlFor="fp-next">{L.forcePassword.next}</label>
            <input
              id="fp-next" type="password" className="field" value={next}
              onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={8}
            />
            <p className="mt-1 text-sm text-slate-500">{L.forcePassword.hint}</p>
          </div>
          <div>
            <label className="label" htmlFor="fp-confirm">{L.forcePassword.confirm}</label>
            <input
              id="fp-confirm" type="password" className="field" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required minLength={8}
            />
          </div>
          <button type="submit" className="btn-primary w-full text-lg" disabled={busy || next.length < 8}>
            {busy ? <Spinner className="h-5 w-5 text-white" /> : L.forcePassword.save}
          </button>
          <button
            type="button" onClick={logout}
            className="w-full rounded-xl py-3 text-sm font-semibold text-slate-500 hover:bg-slate-50"
          >
            {L.logout}
          </button>
        </form>
      </div>
    </div>
  );
}
