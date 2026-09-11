import { useCallback } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import L from '../labels';
import { approvals } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useLiveEvent } from '../lib/live';
import AppHeader from '../components/AppHeader';
import ApprovalQueue from '../components/ApprovalQueue';
import Dashboard from './Console/Dashboard';
import Visits from './Console/Visits';
import People from './Console/People';
import Person from './Console/Person';
import Users from './Console/Users';
import Security from './Console/Security';

/**
 * Superadmin console. The dashboard is the home; approvals, users and the
 * sign-in log sit beside it for the superadmins who run the gate day to day.
 *
 * Tabs are real routes (/console/visits, /console/security, …) rather than
 * in-memory state, so a notification can deep-link to a tab, a drill-down is a
 * link you can send someone, and the back button behaves.
 */
const TABS = [
  { to: '/console', end: true, label: L.console.tabs.dashboard },
  { to: '/console/visits', label: L.console.tabs.visits },
  { to: '/console/people', label: L.console.tabs.people },
  { to: '/console/approvals', label: L.console.tabs.approvals, badge: true },
  { to: '/console/users', label: L.console.tabs.users },
  { to: '/console/security', label: L.console.security.tab },
];

export default function Console() {
  // The approvals badge must show while you are on the dashboard too, so the
  // count is polled here rather than read from the queue component.
  const fetchPending = useCallback(() => approvals.pending(), []);
  const { data, reload, setData } = usePoll(fetchPending, 20000, []);
  useLiveEvent('approvals_changed', () => reload({ silent: true }).catch(() => {}));
  const pendingCount = data ? data.count : 0;
  // While the queue is open it knows the count first; feed it into the same
  // number rather than a second one that would go stale after you leave.
  const onQueueCount = useCallback((n) => setData((d) => ({ ...(d || {}), count: n })), [setData]);

  return (
    <div className="min-h-screen">
      <AppHeader title={L.console.title} />

      <nav className="sticky top-0 z-20 overflow-x-auto border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-4 px-5 py-3 font-semibold ${
                  isActive ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`
              }
            >
              {t.label}
              {t.badge && pendingCount > 0 && (
                <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-sm font-bold text-white">{pendingCount}</span>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-4 pb-16">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="visits" element={<Visits />} />
          <Route path="people" element={<People />} />
          <Route path="people/:id" element={<Person />} />
          <Route path="approvals" element={<ApprovalQueue onCountChange={onQueueCount} />} />
          <Route path="users" element={<Users />} />
          <Route path="security" element={<Security />} />
          <Route path="*" element={<Navigate to="/console" replace />} />
        </Routes>
      </main>
    </div>
  );
}
