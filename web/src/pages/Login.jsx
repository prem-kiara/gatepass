import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import L from '../labels';
import { useAuth, homeFor } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { LoadingBlock, Spinner, ErrorBanner } from '../components/ui';
import PinPad from '../components/PinPad';

const PIN_LENGTH = 6;

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
  useEffect(() => {
    if (!selected || pin.length !== PIN_LENGTH || busy) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        await loginPin(selected.id, pin);
        // On success the auth context sets the user; App routes onward (or forces
        // a PIN change if this was a temporary one).
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setPin('');
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pin, selected, busy, loginPin]);

  if (error && !users) return <div className="p-2"><ErrorBanner error={error} /></div>;
  if (!users) return <LoadingBlock />;

  if (!selected) {
    return (
      <div>
        <p className="mb-4 text-center font-semibold text-slate-700">{L.login.pickName}</p>
        {users.length === 0 ? (
          <p className="py-6 text-center text-slate-500">{L.login.noGuards}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => { setSelected(u); setPin(''); setError(null); }}
                className="min-h-[72px] rounded-2xl bg-brand-50 px-3 py-4 text-lg font-bold text-brand-800 active:bg-brand-100"
              >
                {u.name}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={onUsePassword} className="mt-6 w-full text-center text-brand-700 underline">
          {L.login.usePassword}
        </button>
      </div>
    );
  }

  if (!selected.has_pin) {
    return (
      <div className="text-center">
        <p className="text-lg font-bold text-slate-800">{selected.name}</p>
        <p className="mt-3 text-slate-600">{L.login.noPinYet}</p>
        <button type="button" onClick={onUsePassword} className="btn-primary mt-6 w-full">{L.login.usePassword}</button>
        <button type="button" onClick={() => setSelected(null)} className="mt-3 w-full text-slate-500 underline">
          {L.login.pinBack}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-center text-lg font-bold text-slate-800">{L.login.enterPin(selected.name)}</p>
      {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
      <PinPad value={pin} onChange={setPin} length={PIN_LENGTH} disabled={busy} />
      <div className="mt-4 flex items-center justify-center">
        {busy && <Spinner className="h-6 w-6 text-brand-600" />}
      </div>
      <button type="button" onClick={() => { setSelected(null); setPin(''); setError(null); }} className="mt-2 w-full text-center text-slate-500 underline">
        {L.login.pinBack}
      </button>
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
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
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
        <button type="button" onClick={onUsePin} className="w-full text-center text-brand-700 underline">
          {L.login.usePin}
        </button>
      )}
    </form>
  );
}

export default function Login() {
  const { user, loading } = useAuth();
  // Default to the PIN picker (the common case at the gate); admins tap through
  // to the password form.
  const [mode, setMode] = useState('pin');

  if (loading) return <LoadingBlock />;
  // A user mid-reset is sent to the forced PIN-change screen by App, not here.
  if (user && !user.must_change_pin) return <Navigate to={homeFor(user.role)} replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-3xl">🛡️</div>
          <h1 className="text-3xl font-bold">{L.login.title}</h1>
          <p className="mt-1 text-brand-100">{L.login.subtitle}</p>
        </div>

        <div className="card p-6">
          {mode === 'pin'
            ? <PinLogin onUsePassword={() => setMode('password')} />
            : <PasswordLogin onUsePin={() => setMode('pin')} />}
        </div>
      </div>
    </div>
  );
}
