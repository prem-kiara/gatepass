import { useCallback, useEffect, useState } from 'react';
import L from '../../labels';
import { admin } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate } from '../../lib/format';
import { LoadingBlock, EmptyState, ErrorBanner, Modal, Spinner, Toast } from '../../components/ui';

const ROLES = ['SECURITY', 'ADMIN', 'SUPERADMIN'];

function UserForm({ user, onClose, onSaved }) {
  const editing = Boolean(user);
  const [form, setForm] = useState({
    name: user ? user.name : '',
    username: user ? user.username : '',
    phone: user && user.phone ? user.phone : '',
    role: user ? user.role : 'SECURITY',
    password: '',
  });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      if (editing) {
        // No password here on purpose: an admin-typed password is one they would
        // then know indefinitely. Use Reset password, which issues a one-time one.
        await admin.updateUser(user.id, { name: form.name, phone: form.phone, role: form.role });
      } else {
        await admin.createUser(form);
      }
      onSaved(editing ? L.console.users.updated : L.console.users.created);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  };

  const valid =
    form.name.trim() &&
    (editing || (form.username.trim().length >= 3 && form.password.length >= 8));

  return (
    <Modal
      title={editing ? L.console.users.editTitle : L.console.users.createTitle}
      onClose={onClose}
      footer={
        <div className="flex gap-3">
          <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={saving}>
            {L.cancel}
          </button>
          <button type="button" className="btn-primary flex-1" onClick={save} disabled={saving || !valid}>
            {saving ? <Spinner className="h-5 w-5 text-white" /> : L.save}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <ErrorBanner error={error} />

        <div>
          <label className="label" htmlFor="u-name">{L.console.users.name}</label>
          <input id="u-name" className="field" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>

        <div>
          <label className="label" htmlFor="u-username">{L.console.users.username}</label>
          <input
            id="u-username"
            className="field disabled:bg-slate-100"
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
            disabled={editing}
            autoCapitalize="none"
            autoCorrect="off"
          />
          {!editing && <p className="mt-1 text-sm text-slate-500">{L.console.users.usernameHint}</p>}
        </div>

        <div>
          <label className="label" htmlFor="u-phone">
            {L.console.users.phone} <span className="font-normal text-slate-500">({L.optional})</span>
          </label>
          <input id="u-phone" className="field" value={form.phone} inputMode="numeric" onChange={(e) => set('phone', e.target.value)} />
        </div>

        <div>
          <label className="label" htmlFor="u-role">{L.console.users.roleLabel}</label>
          <select id="u-role" className="field" value={form.role} onChange={(e) => set('role', e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{L.role[r]}</option>
            ))}
          </select>
        </div>

        {!editing && (
          <div>
            <label className="label" htmlFor="u-password">{L.console.users.password}</label>
            <input
              id="u-password"
              type="password"
              className="field"
              value={form.password}
              onChange={(e) => set('password', e.target.value)}
              autoComplete="new-password"
            />
            <p className="mt-1 text-sm text-slate-500">{L.console.users.passwordHint}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Users() {
  // Resetting your own password here would strand you on the forced-change
  // screen; Settings is the right door, so the button is hidden on your own row.
  const { user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState(null);
  const [pinReset, setPinReset] = useState(null); // { user, tempPin }
  const [passwordReset, setPasswordReset] = useState(null); // { user, tempPassword }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { users: list } = await admin.users();
      setUsers(list);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async (user) => {
    if (user.is_active && !window.confirm(L.console.users.confirmDeactivate(user.name))) return;
    try {
      await admin.updateUser(user.id, { is_active: !user.is_active });
      await load();
    } catch (err) {
      setToast({ message: err.message, tone: 'error' });
    }
  };

  const resetPassword = async (user) => {
    if (!window.confirm(L.console.users.confirmResetPassword(user.name))) return;
    try {
      const { tempPassword } = await admin.resetPassword(user.id);
      setPasswordReset({ user, tempPassword });
      await load();
    } catch (err) {
      setToast({ message: err.message, tone: 'error' });
    }
  };

  const resetPin = async (user) => {
    if (!window.confirm(L.console.users.confirmResetPin(user.name))) return;
    try {
      const { tempPin } = await admin.resetPin(user.id);
      setPinReset({ user, tempPin });
      await load();
    } catch (err) {
      setToast({ message: err.message, tone: 'error' });
    }
  };

  const grouped = ROLES.map((role) => ({ role, list: users.filter((u) => u.role === role) })).filter(
    (g) => g.list.length > 0
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-slate-700">{L.console.users.title}</h2>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          {L.console.users.addUser}
        </button>
      </div>

      {error && <ErrorBanner error={error} onRetry={load} />}

      {loading && users.length === 0 ? (
        <LoadingBlock />
      ) : users.length === 0 ? (
        <EmptyState title={L.console.users.none} icon="👥" />
      ) : (
        grouped.map((group) => (
          <section key={group.role}>
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">
              {L.role[group.role]}
            </h3>
            <div className="card divide-y divide-slate-100">
              {group.list.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`truncate font-semibold ${u.is_active ? '' : 'text-slate-400 line-through'}`}>
                        {u.name}
                      </p>
                      {!u.is_active && (
                        <span className="badge border-slate-300 bg-slate-100 text-slate-600">
                          {L.console.users.inactive}
                        </span>
                      )}
                      {/* PIN status, only meaningful for gate staff. */}
                      {u.role === 'SECURITY' && u.pin_locked && (
                        <span className="badge border-red-300 bg-red-50 text-red-700">{L.console.users.pinLocked}</span>
                      )}
                      {u.role === 'SECURITY' && !u.pin_locked && u.has_pin && (
                        <span className="badge border-green-300 bg-green-50 text-green-700">{L.console.users.hasPin}</span>
                      )}
                      {u.role === 'SECURITY' && !u.has_pin && (
                        <span className="badge border-slate-300 bg-slate-100 text-slate-500">{L.console.users.noPin}</span>
                      )}
                    </div>
                    <p className="truncate text-sm text-slate-500">
                      @{u.username}
                      {u.phone && ` · ${u.phone}`}
                      {` · ${formatDate(u.created_at)}`}
                      {u.created_by_name && ` · ${L.console.users.createdBy} ${u.created_by_name}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {u.role === 'SECURITY' && u.is_active && (
                      <button type="button" className="btn-ghost px-4 text-sm" onClick={() => resetPin(u)}>
                        {L.console.users.resetPin}
                      </button>
                    )}
                    {u.is_active && u.id !== (me && me.id) && (
                      <button type="button" className="btn-ghost px-4 text-sm" onClick={() => resetPassword(u)}>
                        {L.console.users.resetPassword}
                      </button>
                    )}
                    <button type="button" className="btn-ghost px-4 text-sm" onClick={() => setEditing(u)}>
                      {L.console.users.editTitle}
                    </button>
                    <button
                      type="button"
                      className={`btn px-4 text-sm ${
                        u.is_active ? 'border-2 border-red-300 bg-white text-red-700' : 'bg-green-600 text-white'
                      }`}
                      onClick={() => toggleActive(u)}
                    >
                      {u.is_active ? L.console.users.deactivate : L.console.users.reactivate}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {(creating || editing) && (
        <UserForm
          user={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(message) => {
            setCreating(false);
            setEditing(null);
            setToast({ message, tone: 'success' });
            load();
          }}
        />
      )}

      {pinReset && (
        <Modal
          title={L.console.users.pinResetTitle}
          onClose={() => setPinReset(null)}
          footer={
            <button type="button" className="btn-primary w-full" onClick={() => setPinReset(null)}>
              {L.done}
            </button>
          }
        >
          <div className="space-y-4 text-center">
            <p className="text-slate-600">{L.console.users.pinResetBody(pinReset.user.name)}</p>
            <div className="rounded-2xl bg-slate-100 py-6 text-4xl font-bold tracking-[0.4em] text-slate-800">
              {pinReset.tempPin}
            </div>
            <p className="text-sm text-slate-500">{L.console.users.pinResetLogged}</p>
          </div>
        </Modal>
      )}

      {passwordReset && (
        <Modal
          title={L.console.users.passwordResetTitle}
          onClose={() => setPasswordReset(null)}
          footer={
            <button type="button" className="btn-primary w-full" onClick={() => setPasswordReset(null)}>
              {L.done}
            </button>
          }
        >
          <div className="space-y-4 text-center">
            <p className="text-slate-600">{L.console.users.passwordResetBody(passwordReset.user.name)}</p>
            <div className="rounded-2xl bg-slate-100 py-6 font-mono text-2xl font-bold tracking-widest text-slate-800">
              {passwordReset.tempPassword}
            </div>
            <p className="text-sm text-slate-500">{L.console.users.pinResetLogged}</p>
          </div>
        </Modal>
      )}

      <Toast message={toast && toast.message} tone={toast && toast.tone} onDone={() => setToast(null)} />
    </div>
  );
}
