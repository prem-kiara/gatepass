import { useState } from 'react';
import L from '../labels';
import AppHeader from '../components/AppHeader';
import ApprovalQueue from '../components/ApprovalQueue';

export default function Approvals() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen">
      <AppHeader
        title={L.approvals.title}
        right={
          count > 0 && (
            <span className="rounded-full bg-amber-500 px-3 py-1 text-sm font-bold text-white">{count}</span>
          )
        }
      />
      <main className="mx-auto max-w-2xl px-4 pb-10">
        <ApprovalQueue onCountChange={setCount} />
      </main>
    </div>
  );
}
