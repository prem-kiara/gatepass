import L from '../labels';

/**
 * Big-button numeric PIN entry for the gate phone: 6 dots and a keypad sized for
 * a 55-year-old's thumb in sunlight. Controlled — the parent owns the value and
 * decides what to do when it reaches full length.
 */
export default function PinPad({ value, onChange, length = 6, disabled = false }) {
  const press = (digit) => {
    if (disabled || value.length >= length) return;
    onChange(value + digit);
  };
  const backspace = () => {
    if (disabled) return;
    onChange(value.slice(0, -1));
  };

  return (
    <div>
      {/* Filled / empty dots */}
      <div className="mb-6 flex justify-center gap-3" aria-hidden="true">
        {Array.from({ length }).map((_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border-2 ${
              i < value.length ? 'border-brand-600 bg-brand-600' : 'border-slate-300'
            }`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => press(String(n))}
            disabled={disabled}
            className="h-16 rounded-2xl bg-slate-100 text-2xl font-bold text-slate-800 active:bg-slate-200 disabled:opacity-50"
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange('')}
          disabled={disabled || value.length === 0}
          className="h-16 rounded-2xl text-base font-semibold text-slate-500 disabled:opacity-30"
        >
          {L.login.pinClear}
        </button>
        <button
          key={0}
          type="button"
          onClick={() => press('0')}
          disabled={disabled}
          className="h-16 rounded-2xl bg-slate-100 text-2xl font-bold text-slate-800 active:bg-slate-200 disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={disabled || value.length === 0}
          className="h-16 rounded-2xl text-2xl text-slate-500 active:bg-slate-100 disabled:opacity-30"
          aria-label="Backspace"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
