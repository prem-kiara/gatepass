import { useEffect, useRef, useState } from 'react';
import L from '../labels';
import { gate } from '../lib/api';
import PhotoCapture from './PhotoCapture';
import { Spinner, ErrorBanner } from './ui';

const OTHER = '__other__';

/**
 * Camera-first stepper: photo → details → members → submit.
 * Kept as one full-screen flow rather than a scrolling form so each step has
 * exactly one obvious action on a small screen.
 */
export default function NewVisitorFlow({ hosts, onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [photo, setPhoto] = useState(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [fromType, setFromType] = useState('');
  const [fromDetail, setFromDetail] = useState('');
  const [hostId, setHostId] = useState('');
  const [hostName, setHostName] = useState('');
  const [members, setMembers] = useState([]);
  const [repeat, setRepeat] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const lookupTimer = useRef(null);
  // Object URLs are created per capture; release them all when the flow unmounts.
  const createdUrls = useRef([]);
  const track = (p) => {
    if (p && p.previewUrl) createdUrls.current.push(p.previewUrl);
    return p;
  };

  useEffect(
    () => () => {
      createdUrls.current.forEach((url) => URL.revokeObjectURL(url));
    },
    []
  );

  // Repeat-visitor prefill: as soon as a full 10-digit number is typed, look it up.
  useEffect(() => {
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) {
      setRepeat(null);
      return undefined;
    }
    clearTimeout(lookupTimer.current);
    lookupTimer.current = setTimeout(async () => {
      try {
        const { found, visitor } = await gate.lookup(digits);
        if (!found) return setRepeat(null);
        setRepeat(visitor);
        // Only fill blanks — never overwrite what the guard already typed.
        setFullName((current) => current || visitor.full_name || '');
        setPurpose((current) => current || visitor.purpose || '');
        setFromType((current) => current || visitor.from_type || '');
        setFromDetail((current) => current || visitor.from_detail || '');
        setHostId((current) => current || visitor.host_admin_id || '');
        if (!visitor.host_admin_id && visitor.host_name) {
          setHostId((current) => current || OTHER);
          setHostName((current) => current || visitor.host_name);
        }
      } catch (err) {
        setRepeat(null);
      }
    }, 400);
    return () => clearTimeout(lookupTimer.current);
  }, [phone]);

  const addMember = () => setMembers((m) => [...m, { id: crypto.randomUUID(), name: '', photo: null }]);
  const updateMember = (id, patch) =>
    setMembers((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const removeMember = (id) => setMembers((m) => m.filter((x) => x.id !== id));

  // A category is now mandatory. Company and Government must also name which one;
  // Private need not.
  const fromValid =
    fromType !== '' && (fromType === 'PRIVATE' || fromDetail.trim().length > 0);
  const detailsValid =
    fullName.trim().length > 0 &&
    fromValid &&
    (hostId === OTHER ? hostName.trim().length > 0 : hostId.length > 0);
  const membersValid = members.every((m) => m.name.trim() && m.photo);

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('photo', photo.blob, 'visitor.jpg');
      form.append('full_name', fullName.trim());
      if (phone.trim()) form.append('phone', phone.trim());
      if (purpose.trim()) form.append('purpose', purpose.trim());
      if (fromType) {
        form.append('from_type', fromType);
        if (fromDetail.trim()) form.append('from_detail', fromDetail.trim());
      }
      if (hostId === OTHER) form.append('host_name', hostName.trim());
      else form.append('host_admin_id', hostId);

      // Names travel as JSON aligned by index with the companion_photos files.
      form.append('companions', JSON.stringify(members.map((m) => ({ name: m.name.trim() }))));
      members.forEach((m, i) => form.append('companion_photos', m.photo.blob, `member-${i + 1}.jpg`));

      const { visit } = await gate.create(form);
      onCreated(visit);
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  };

  const steps = [L.gate.stepPhoto, L.gate.stepDetails, L.gate.stepMembers];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-slate-100">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={onClose} className="p-2 text-2xl leading-none text-slate-500" aria-label={L.cancel}>
          ×
        </button>
        <div className="flex-1">
          <p className="font-bold">{L.gate.newVisitor.replace('+ ', '')}</p>
          <div className="mt-1 flex gap-1.5" aria-hidden="true">
            {steps.map((name, i) => (
              <span
                key={name}
                className={`h-1.5 flex-1 rounded-full ${i + 1 <= step ? 'bg-brand-600' : 'bg-slate-200'}`}
              />
            ))}
          </div>
        </div>
        <span className="text-sm font-semibold text-slate-500">{steps[step - 1]}</span>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto max-w-md space-y-5">
          <ErrorBanner error={error} />

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-center text-slate-600">{L.gate.photoHint}</p>
              <PhotoCapture value={photo} onChange={(p) => setPhoto(track(p))} />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <label className="label" htmlFor="v-name">{L.gate.fullName}</label>
                <input
                  id="v-name"
                  className="field"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={L.gate.fullNamePlaceholder}
                  autoComplete="off"
                />
              </div>

              <div>
                <label className="label" htmlFor="v-phone">
                  {L.gate.phone} <span className="font-normal text-slate-500">({L.optional})</span>
                </label>
                <input
                  id="v-phone"
                  className="field"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="numeric"
                  placeholder={L.gate.phoneHint}
                  autoComplete="off"
                />
                {repeat && (
                  <p className="mt-2 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">
                    ↻ {L.gate.repeatVisitorFound(repeat.full_name, repeat.visit_count)}
                  </p>
                )}
              </div>

              <div>
                <label className="label" htmlFor="v-purpose">{L.gate.purpose}</label>
                <input
                  id="v-purpose"
                  className="field"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder={L.gate.purposePlaceholder}
                />
              </div>

              <div>
                <label className="label" htmlFor="v-from-type">{L.gate.from.label}</label>
                <select
                  id="v-from-type"
                  className="field"
                  value={fromType}
                  onChange={(e) => {
                    setFromType(e.target.value);
                    setFromDetail(''); // clear the detail when the category changes
                  }}
                >
                  <option value="">{L.gate.from.none}</option>
                  {['COMPANY', 'PRIVATE', 'GOVERNMENT'].map((t) => (
                    <option key={t} value={t}>{L.gate.from.types[t]}</option>
                  ))}
                </select>

                {fromType && (
                  <input
                    id="v-from-detail"
                    className="field mt-3"
                    value={fromDetail}
                    onChange={(e) => setFromDetail(e.target.value)}
                    placeholder={L.gate.from.detailPlaceholder[fromType]}
                    aria-label={L.gate.from.detailLabel[fromType]}
                    autoComplete="off"
                  />
                )}
              </div>

              <div>
                <label className="label" htmlFor="v-host">{L.gate.whomToVisit}</label>
                <select id="v-host" className="field" value={hostId} onChange={(e) => setHostId(e.target.value)}>
                  <option value="">{L.gate.selectHost}</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>{h.name}</option>
                  ))}
                  <option value={OTHER}>{L.gate.otherHost}</option>
                </select>
                {hostId === OTHER && (
                  <input
                    className="field mt-3"
                    value={hostName}
                    onChange={(e) => setHostName(e.target.value)}
                    placeholder={L.gate.otherHostPlaceholder}
                  />
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <p className="text-slate-600">{members.length === 0 ? L.gate.noMembers : L.gate.members}</p>

              {members.map((m, i) => (
                <div key={m.id} className="card flex gap-3 p-3">
                  <PhotoCapture
                    value={m.photo}
                    onChange={(p) => updateMember(m.id, { photo: track(p) })}
                    label={L.gate.memberPhoto}
                    size="small"
                  />
                  <div className="flex flex-1 flex-col justify-between gap-2">
                    <input
                      className="field"
                      value={m.name}
                      onChange={(e) => updateMember(m.id, { name: e.target.value })}
                      placeholder={`${L.gate.memberName} ${i + 1}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeMember(m.id)}
                      className="self-start px-1 py-2 text-sm font-semibold text-red-700"
                    >
                      {L.gate.removeMember}
                    </button>
                  </div>
                </div>
              ))}

              <button type="button" onClick={addMember} className="btn-ghost w-full border-dashed">
                {L.gate.addMember}
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-slate-200 bg-white px-4 py-4">
        <div className="mx-auto flex max-w-md gap-3">
          {step > 1 && (
            <button type="button" className="btn-ghost flex-1" onClick={() => setStep(step - 1)} disabled={submitting}>
              {L.back}
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              className="btn-primary flex-[2] text-lg"
              disabled={(step === 1 && !photo) || (step === 2 && !detailsValid)}
              onClick={() => setStep(step + 1)}
            >
              {L.next}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary flex-[2] text-lg"
              disabled={submitting || !membersValid}
              onClick={submit}
            >
              {submitting ? <><Spinner className="h-5 w-5 text-white" /> {L.gate.submitting}</> : L.gate.submit}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
