# STATE — running changelog

Newest entries at the top. Append one entry per change.

---

## 2026-07-24 — Phase 1: Foundation

- Repo scaffold: `server/` (Express, CommonJS) + `web/` (Vite + React 18 + Tailwind 3).
- `CLAUDE.md` with stack context, conventions, and shared-VM deployment guardrails.
- Migration runner (`server/migrate.js`) applying numbered SQL files, tracked in a `migrations` table.
- `001_init.sql`: `users`, `visitors`, `visits`, `visit_companions`, `visit_events` + indexes.
  `visit_events` is append-only, enforced by a trigger that raises on UPDATE/DELETE.
- Idempotent superadmin seed (`server/seed.js`, env `SEED_ADMIN_USER` / `SEED_ADMIN_PASS` / `SEED_ADMIN_NAME`).
- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. bcryptjs hashes,
  JWT in an httpOnly cookie, 12h for SECURITY and 7d for ADMIN/SUPERADMIN. Login is rate limited.
- Role middleware (`requireAuth`, `requireRole`) applied per route.
- Superadmin user CRUD: list/create/update/deactivate/reset-password. Deactivation only, never deletion.

## 2026-07-24 — Phase 2: Core visit flow

- Photo pipeline: client-side canvas compression (max edge 1024px, JPEG 0.8) → multer memory upload
  → sharp normalize + EXIF strip → UUID filename on disk. Served only via authenticated
  `GET /api/photos/:filename` with a strict filename allowlist.
- `POST /api/visits` — multipart, creates a PENDING visit with primary photo, optional phone,
  purpose, host (admin or free-text), and any number of companions (name + photo each).
- `GET /api/visits/today`, `POST /api/visits/:id/check-in`, `POST /api/visits/:id/check-out`
  (one action covers the whole group), `GET /api/visitors/lookup?phone=` for repeat-visitor prefill.
- `GET /api/approvals/pending` (shared queue for all admins + superadmin, includes `waiting_seconds`
  and an `unattended` flag after 10 minutes), `POST /api/visits/:id/approve`, `POST /api/visits/:id/reject`.
- **First-approval-wins** implemented as a conditional UPDATE; a losing admin gets `409` carrying the
  recorded decision so their card flips to "Approved by <name>" rather than showing an error.
- All mutations write a `visit_events` row inside the same transaction.
- Security screen (`/gate`): camera-first stepper, add-member loop, today's list with status colours
  and one big action per card, 10s polling.
- Admin screen (`/approvals`): shared pending queue with photos, companions, waiting time, tap-to-call,
  approve/reject with optional reason, own-decision history, 15s polling.

## 2026-07-24 — Phase 3: Superadmin console

- `/console` with tabs: Approvals (same shared queue), Dashboard, Visits, Users.
- Dashboard: today's pending/approved/inside/checked-out counts, per-admin approval counts,
  unattended-request count, and never-checked-out flags.
- `GET /api/admin/visits` — filter by date range, status, approving admin, and free-text search over
  visitor name/phone; paginated. Each row expands to photos, companions, host, and full audit trail
  via `GET /api/admin/visits/:id/events`.
- `GET /api/admin/report/daily?date=&format=csv` — counts plus CSV export.

## 2026-07-24 — Phase 4: Polish & ship

- PWA manifest + service worker (app-shell caching only; no offline writes in v1).
- Rate limiting on login, request-size caps, phone/role/input validation hardening, consistent
  error envelope, empty and error states across all screens.
- `ecosystem.config.js` (PM2, process name `gatepass`) and `deploy.sh`.
- Deployed to the shared EC2 VM on 127.0.0.1:3040 behind its own nginx server block for
  `gatepass.dhanamfinance.com`, TLS via a single-domain certbot certificate. Existing apps untouched.

---

## v2 candidates (out of scope for v1)

- OTP verification of the visitor's phone number.
- WhatsApp/SMS notification to the host admin — `notifyAdmin()` is stubbed in `server/lib/notify.js`.
- Multi-building / multi-gate support.
- Tamil UI toggle (all strings already isolated in `web/src/labels.ts`).
- Visitor badges / QR passes.
- Offline write support in the PWA.
