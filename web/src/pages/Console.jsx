import { useState } from 'react';
import L from '../labels';
import AppHeader from '../components/AppHeader';
import ApprovalQueue from '../components/ApprovalQueue';
import Dashboard from './Console/Dashboard';
import Visits from './Console/Visits';
import Users from './Console/Users';
import Security from './Console/Security';

const TABS = [
  { key: 'approvals', label: L.console.tabs.approvals },
  { key: 'dashboard', label: L.console.tabs.dashboard },
  { key: 'visits', label: L.console.tabs.visits },
  { key: 'users', label: L.console.tabs.users },
  { key: 'security', label: L.console.security.tab },
];

export default function Console() {
  const [tab, setTab] = useState('approvals');
  const [pendingCount, setPendingCount] = useState(0);

  return (
    <div className="min-h-screen">
      <AppHeader title={L.console.title} />

      <nav className="sticky top-0 z-20 overflow-x-auto border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`whitespace-nowrap border-b-4 px-5 py-3 font-semibold ${
                tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500'
              }`}
            >
              {t.label}
              {t.key === 'approvals' && pendingCount > 0 && (
                <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-sm font-bold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-4 pb-16">
        {tab === 'approvals' && <ApprovalQueue onCountChange={setPendingCount} />}
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'visits' && <Visits />}
        {tab === 'users' && <Users />}
        {tab === 'security' && <Security />}
      </main>
    </div>
  );
}
