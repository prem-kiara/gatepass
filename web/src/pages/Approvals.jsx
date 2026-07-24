import L from '../labels';
import AppHeader from '../components/AppHeader';
import ApprovalQueue from '../components/ApprovalQueue';

export default function Approvals() {
  return (
    <div className="min-h-screen">
      {/* The pending count lives on the "Pending" tab, and the bell carries the
          unread count — a third badge up here only competed with them. */}
      <AppHeader title={L.approvals.title} />
      <main className="mx-auto max-w-2xl px-4 pb-10">
        <ApprovalQueue />
      </main>
    </div>
  );
}
