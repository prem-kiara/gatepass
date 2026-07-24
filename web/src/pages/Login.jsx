import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import L from '../labels';
import { useAuth, homeFor } from '../lib/auth';
import { LoadingBlock, Spinner, ErrorBanner } from '../components/ui';

export default function Login() {
  const { user, loading, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <LoadingBlock />;
  if (user) return <Navigate to={homeFor(user.role)} replace />;

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10 text-3xl">
            🛡️
          </div>
          <h1 className="text-3xl font-bold">{L.login.title}</h1>
          <p className="mt-1 text-brand-100">{L.login.subtitle}</p>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <ErrorBanner error={error} />

          <div>
            <label className="label" htmlFor="username">{L.login.username}</label>
            <input
              id="username"
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">{L.login.password}</label>
            <input
              id="password"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit" className="btn-primary w-full text-lg" disabled={submitting}>
            {submitting ? <><Spinner className="h-5 w-5 text-white" /> {L.login.signingIn}</> : L.login.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
