import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import L from '../labels';
import { useAuth } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { registerPasskey, passkeyDevices, passkeySupported } from '../lib/passkey';
import { Spinner, ErrorBanner, Toast } from '../components/ui';

function Section({ title, children }) {
  return (
    <section className="card p-5">
      <h2 className="mb-3 text-base font-bold text-slate-700">{title}</h2>
      {children}
    </section>
  );
}

const numericProps = { inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autoComplete: 'off' };

/** Guards set or change their 6-digit gate PIN here. */
function PinSection({ user, onToast }) {
  const { refresh } = useAuth();
  const hasPin = user.has_pin;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    if (next !== confirm) return setError({ message: L.settings.pinMismatch });
    setBusy(true);
    try {
      await authApi.setPin(next, hasPin ? current : undefined);
      await refresh();
      setCurrent(''); setNext(''); setConfirm('');
      onToast({ message: L.settings.pinSaved, tone: 'success' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={L.settings.pinSection}>
      <p className="mb-3 text-sm text-slate-500">{hasPin ? L.settings.pinHasSet : L.settings.pinNotSet}</p>
      {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
      <div className="space-y-3">
        {hasPin && (
          <input className="field" placeholder={L.settings.currentPin} value={current}
            onChange={(e) => setCurrent(e.target.value.replace(/\D/g, ''))} {...numericProps} />
        )}
        <input className="field" placeholder={L.settings.newPin} value={next}
          onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))} {...numericProps} />
        <input className="field" placeholder={L.settings.confirmPin} value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} {...numericProps} />
        <button type="button" className="btn-primary w-full" disabled={busy || next.length < 6 || confirm.length < 6}
          onClick={save}>
          {busy ? <Spinner className="h-5 w-5 text-white" /> : hasPin ? L.settings.changePin : L.settings.setPin}
        </button>
      </div>
    </Section>
  );
}

/** Admins enable Face ID / fingerprint on each device, and manage the list. */
function BiometricSection({ onToast }) {
  const [devices, setDevices] = useState([]);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { devices: list } = await passkeyDevices.list();
      setDevices(list);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    setSupported(passkeySupported());
    load();
  }, [load]);

  const enable = async () => {
    setError(null);
    setBusy(true);
    try {
      // Label the device by its platform so the list is readable later.
      const label = /iphone|ipad/i.test(navigator.userAgent) ? 'iPhone (Face ID)'
        : /android/i.test(navigator.userAgent) ? 'Android (fingerprint)'
        : 'This device';
      await registerPasskey(label);
      await load();
      onToast({ message: L.settings.biometricAdded, tone: 'success' });
    } catch (err) {
      if (!(err && (err.name === 'NotAllowedError' || err.name === 'AbortError'))) {
        setError({ message: err.message || L.settings.biometricFailed });
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(L.settings.confirmRemove)) return;
    try {
      await passkeyDevices.remove(id);
      await load();
      onToast({ message: L.settings.deviceRemoved, tone: 'success' });
    } catch (err) {
      onToast({ message: err.message, tone: 'error' });
    }
  };

  return (
    <Section title={L.settings.biometricSection}>
      {!supported ? (
        <p className="text-sm text-slate-500">{L.settings.biometricUnsupported}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-500">{L.settings.biometricWhat}</p>
          {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
          <button type="button" className="btn-primary w-full" disabled={busy} onClick={enable}>
            {busy ? <><Spinner className="h-5 w-5 text-white" /> {L.settings.biometricAdding}</> : `🔐 ${L.settings.biometricAdd}`}
          </button>

          <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-600">{L.settings.devicesTitle}</h3>
          {devices.length === 0 ? (
            <p className="text-sm text-slate-400">{L.settings.noDevices}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-700">{d.device_label}</p>
                    <p className="text-xs text-slate-400">
                      {L.settings.added} {formatDateTime(d.created_at)} · {L.settings.lastUsed}{' '}
                      {d.last_used_at ? formatDateTime(d.last_used_at) : L.settings.never}
                    </p>
                  </div>
                  <button type="button" className="text-sm font-semibold text-red-600" onClick={() => remove(d.id)}>
                    {L.settings.removeDevice}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function PasswordSection({ onToast }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setCurrent(''); setNext('');
      onToast({ message: L.settings.passwordSaved, tone: 'success' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={L.settings.passwordSection}>
      {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
      <div className="space-y-3">
        <input className="field" type="password" placeholder={L.settings.currentPassword} value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        <input className="field" type="password" placeholder={L.settings.newPassword} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        <button type="button" className="btn-primary w-full" disabled={busy || !current || next.length < 8} onClick={save}>
          {busy ? <Spinner className="h-5 w-5 text-white" /> : L.settings.changePassword}
        </button>
      </div>
    </Section>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [toast, setToast] = useState(null);
  if (!user) return null;

  const isGuard = user.role === 'SECURITY';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-brand-700 bg-brand-600 text-white">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
          <button type="button" onClick={() => navigate(-1)} className="rounded-lg border border-brand-500 px-3 py-2 text-sm font-semibold">
            ← {L.settings.back}
          </button>
          <h1 className="text-lg font-bold">{L.settings.title}</h1>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {isGuard && <PinSection user={user} onToast={setToast} />}
        {!isGuard && <BiometricSection onToast={setToast} />}
        <PasswordSection onToast={setToast} />
      </main>

      <Toast message={toast && toast.message} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
