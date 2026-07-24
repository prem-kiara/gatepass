import L from '../labels';
import { useAuth } from '../lib/auth';

/**
 * Deliberately flat: title, who is signed in, and a log-out button.
 * No hamburger menu — security staff should never have to hunt for anything.
 */
export default function AppHeader({ title, right }) {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-30 border-b border-brand-700 bg-brand-600 text-white">
      <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{title}</h1>
          {user && (
            <p className="truncate text-sm text-brand-100">
              {user.name} · {L.role[user.role]}
            </p>
          )}
        </div>
        {right}
        <button
          type="button"
          onClick={logout}
          className="shrink-0 rounded-lg border border-brand-500 px-3 py-2 text-sm font-semibold hover:bg-brand-700"
        >
          {L.logout}
        </button>
      </div>
    </header>
  );
}
