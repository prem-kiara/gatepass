import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import L from '../labels';
import { useAuth, homeFor } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { LoadingBlock, Spinner, ErrorBanner } from '../components/ui';
import PinPad from '../components/PinPad';

const PIN_LENGTH = 6;

/** Two-letter initials for the name avatars. */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function Avatar({ name, size = 'md' }) {
  const dims = size === 'lg' ? 'h-16 w-16 text-2xl' : 'h-11 w-11 text-base';
  return (
    <span className={`flex ${dims} shrink-0 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700`}>
      {initials(name)}
    </span>
  );
}

/** A quiet full-width secondary action — replaces the underlined text links. */
function SecondaryButton({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl py-3 text-sm font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
    >
      {children}
    </button>
  );
}

/** Guard flow: pick your name, then key in your PIN. */
function PinLogin({ onUsePassword }) {
  const { loginPin } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // { id, name, has_pin }
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authApi.gateUsers().then((r) => setUsers(r.users)).catch((e) => setError(e));
  }, []);

  // Submit automatically once the PIN is complete — no extra button to hunt for.
  //
  // The in-flight guard is a ref rather than state: with `busy` in the
  // dependency list, setBusy(true) re-ran this effect and the re-run's cleanup
  // cancelled the request still in flight. A correct PIN survived that (the
  // redirect unmounts the screen), but a WRONG one left the guard staring at a
  // spinner that never resolved and never said "Wrong PIN".
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!selected || pin.length !== PIN_LENGTH || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        await loginPin(selected.id, pin);
        // On success the auth context sets the user; App routes onward (or forces
        // a PIN change if this was a temporary one).
      } catch (err) {
        setError(err);
        setPin('');
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    })();
  }, [pin, selected, loginPin]);

  if (error && !users) return <div className="p-2"><ErrorBanner error={error} /></div>;
  if (!users) return <LoadingBlock />;

  if (!selected) {
    return (
      <div>
        <p className="mb-4 text-center text-sm font-semibold uppercase tracking-wide text-slate-400">
          {L.login.pickName}
        </p>
        {users.length === 0 ? (
          <p className="py-6 text-center text-slate-500">{L.login.noGuards}</p>
        ) : (
          <div className="space-y-2">
            {users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { setSelected(u); setPin(''); setError(null); }}
                className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition active:scale-[0.99] active:bg-slate-50 hover:border-brand-200 hover:bg-brand-50/40"
              >
                <Avatar name={u.name} />
                <span className="min-w-0 flex-1 truncate text-lg font-semibold text-slate-800">{u.name}</span>
                <span className="text-slate-300" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 border-t border-slate-100 pt-3">
          <SecondaryButton onClick={onUsePassword}>{L.login.usePassword}</SecondaryButton>
        </div>
      </div>
    );
  }

  if (!selected.has_pin) {
    return (
      <div className="text-center">
        <div className="mb-4 flex flex-col items-center gap-2">
          <Avatar name={selected.name} size="lg" />
          <p className="text-lg font-bold text-slate-800">{selected.name}</p>
        </div>
        <p className="text-slate-600">{L.login.noPinYet}</p>
        <button type="button" onClick={onUsePassword} className="btn-primary mt-6 w-full">{L.login.usePassword}</button>
        <div className="mt-2">
          <SecondaryButton onClick={() => setSelected(null)}>{L.login.pinBack}</SecondaryButton>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-5 flex flex-col items-center gap-2">
        <Avatar name={selected.name} size="lg" />
        <p className="text-lg font-bold text-slate-800">{selected.name}</p>
        <p className="text-sm text-slate-500">{L.login.enterYourPin}</p>
      </div>
      {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
      <PinPad value={pin} onChange={setPin} length={PIN_LENGTH} disabled={busy} />
      <div className="mt-4 flex h-6 items-center justify-center">
        {busy && <Spinner className="h-6 w-6 text-brand-600" />}
      </div>
      <SecondaryButton onClick={() => { setSelected(null); setPin(''); setError(null); }}>
        {L.login.pinBack}
      </SecondaryButton>
    </div>
  );
}

/** Password flow — the backup for everyone, and how admins/superadmin sign in. */
function PasswordLogin({ onUsePin }) {
  const { login, loginPasskey } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [canBiometric, setCanBiometric] = useState(false);

  useEffect(() => {
    import('../lib/passkey').then((m) => setCanBiometric(m.passkeySupported())).catch(() => {});
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  const onBiometric = async () => {
    setError(null);
    try {
      await loginPasskey();
    } catch (err) {
      // A user cancelling the Face ID sheet is not an error worth shouting about.
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
      setError({ message: L.login.biometricFailed });
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ErrorBanner error={error} />

      {canBiometric && (
        <>
          <button type="button" onClick={onBiometric} className="btn-primary w-full text-lg">
            🔐 {L.login.useBiometric}
          </button>
          <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200" /> {L.or || 'or'} <span className="h-px flex-1 bg-slate-200" />
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="username">{L.login.username}</label>
        <input
          id="username" className="field" value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username" autoCapitalize="none" autoCorrect="off" required
        />
      </div>
      <div>
        <label className="label" htmlFor="password">{L.login.password}</label>
        <input
          id="password" type="password" className="field" value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required
        />
      </div>
      <button type="submit" className="btn-primary w-full text-lg" disabled={submitting}>
        {submitting ? <><Spinner className="h-5 w-5 text-white" /> {L.login.signingIn}</> : L.login.submit}
      </button>
      {onUsePin && (
        <div className="border-t border-slate-100 pt-3">
          <SecondaryButton onClick={onUsePin}>{L.login.usePin}</SecondaryButton>
        </div>
      )}
    </form>
  );
}

const MODE_KEY = 'gp_login_mode';

export default function Login() {
  const { user, loading } = useAuth();
  // Default to the PIN picker (the common case at the gate), but remember what
  // this device used last so an admin's phone opens on their own sign-in.
  const [mode, setModeState] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'password' ? 'password' : 'pin';
    } catch (err) {
      return 'pin';
    }
  });
  const setMode = (next) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch (err) {
      /* private mode — the default is fine */
    }
  };

  if (loading) return <LoadingBlock />;
  // A user mid-reset is sent to the forced PIN-change screen by App, not here.
  if (user && !user.must_change_pin) return <Navigate to={homeFor(user.role)} replace />;

  return (
    <div className="flex min-h-screen flex-col bg-brand-900 px-4 py-8">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center text-white">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-3xl ring-1 ring-white/15">
              🛡️
            </div>
            <h1 className="text-3xl font-bold tracking-tight">{L.login.title}</h1>
            <p className="mt-1 text-brand-100">{L.login.subtitle}</p>
          </div>

          <div className="card p-6 shadow-xl">
            {mode === 'pin'
              ? <PinLogin onUsePassword={() => setMode('password')} />
              : <PasswordLogin onUsePin={() => setMode('pin')} />}
          </div>
        </div>
      </div>

      <p className="pt-6 text-center text-xs text-brand-200/70">{L.login.subtitle} · Dhanam Finance</p>
    </div>
  );
}
