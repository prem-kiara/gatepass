import { useRef, useState } from 'react';
import L from '../labels';
import { compressImage } from '../lib/image';
import { Spinner } from './ui';

/**
 * Camera-first capture. `capture="environment"` opens the phone camera directly
 * on Android and iOS with no native app or permissions dance; on a desktop
 * browser it degrades to a file picker, which is what we want for testing.
 *
 * Calls `onChange({ blob, previewUrl })`, or `onChange(null)` when cleared.
 */
export default function PhotoCapture({ value, onChange, label = L.gate.takePhoto, size = 'large' }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const pick = () => inputRef.current && inputRef.current.click();

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset immediately so retaking the *same* file still fires a change event.
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const result = await compressImage(file);
      if (value && value.previewUrl) URL.revokeObjectURL(value.previewUrl);
      onChange(result);
    } catch (err) {
      setError(err.message || L.somethingWrong);
    } finally {
      setBusy(false);
    }
  };

  const isLarge = size === 'large';
  const frame = isLarge ? 'aspect-[3/4] max-h-[46vh]' : 'h-28 w-28';

  return (
    <div className={isLarge ? 'w-full' : ''}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFile}
        className="hidden"
      />

      {value ? (
        <div className={isLarge ? 'space-y-3' : 'space-y-2'}>
          <div className={`${frame} overflow-hidden rounded-2xl border-2 border-slate-300 bg-slate-900`}>
            <img src={value.previewUrl} alt={label} className="h-full w-full object-cover" />
          </div>
          <button type="button" onClick={pick} className={`btn-ghost ${isLarge ? 'w-full' : 'w-28 px-2 text-sm'}`} disabled={busy}>
            {busy ? <Spinner className="h-5 w-5" /> : L.gate.retake}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className={`${frame} flex w-full flex-col items-center justify-center gap-3 rounded-2xl
                      border-4 border-dashed border-brand-300 bg-brand-50 text-brand-700
                      active:scale-[0.99] disabled:opacity-60`}
        >
          {busy ? (
            <Spinner className="h-8 w-8" />
          ) : (
            <>
              <span className={isLarge ? 'text-5xl' : 'text-2xl'} aria-hidden="true">📷</span>
              <span className={`font-bold ${isLarge ? 'text-lg' : 'text-xs'}`}>{label}</span>
            </>
          )}
        </button>
      )}

      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
