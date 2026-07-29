import { useState } from 'react';
import L from '../labels';
import { useAuth } from '../lib/auth';
import { auth as authApi } from '../lib/api';
import { Spinner, ErrorBanner } from './ui';
import PinPad from './PinPad';

const PIN_LENGTH = 6;

/**
 * Shown when a guard signs in with a temporary PIN (issued by a superadmin
 * reset, flagged as must_change_pin). They cannot reach the app until they have
 * replaced it with a private one — which is what stops a reset from doubling as
 * a working PIN that someone else knows.
 */
export default function ForcePinChange() {
  const { refresh, logout } = useAuth();
  const [step, setStep] = useState('new'); // 'new' | 'confirm'
  const [first, setFirst] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (confirmPin) => {
    setBusy(true);
    setError(null);
    try {
      await authApi.setPin(confirmPin);
      await refresh(); // clears must_change_pin, App routes onward
    } catch (err) {
      setError(err);
      setStep('new');
      setFirst('');
      setConfirm('');
      setBusy(false);
    }
  };

  const onFirstChange = (v) => {
    setFirst(v);
    if (v.length === PIN_LENGTH) setStep('confirm');
  };
  const onConfirmChange = (v) => {
    setConfirm(v);
    if (v.length === PIN_LENGTH) {
      if (v !== first) {
        setError({ message: L.login.pinMismatch });
        setStep('new');
        setFirst('');
        setConfirm('');
      } else {
        submit(v);
      }
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <h1 className="text-2xl font-bold">{L.login.setPinTitle}</h1>
          <p className="mt-1 text-brand-100">{L.login.setPinWhy}</p>
        </div>
        <div className="card p-6">
          {error && <div className="mb-3"><ErrorBanner error={error} /></div>}
          <p className="mb-4 text-center font-semibold text-slate-700">
            {step === 'new' ? L.login.newPin : L.login.confirmPin}
          </p>
          {step === 'new'
            ? <PinPad value={first} onChange={onFirstChange} length={PIN_LENGTH} disabled={busy} />
            : <PinPad value={confirm} onChange={onConfirmChange} length={PIN_LENGTH} disabled={busy} />}
          <div className="mt-4 flex justify-center">{busy && <Spinner className="h-6 w-6 text-brand-600" />}</div>
          <button type="button" onClick={logout} className="mt-3 w-full text-center text-slate-500 underline">
            {L.logout}
          </button>
        </div>
      </div>
    </div>
  );
}
