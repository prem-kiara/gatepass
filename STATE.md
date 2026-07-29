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

## 2026-07-29 — Visitor company

Captures the company/organisation each visitor is visiting from — `005_visit_company.sql` adds
`visits.company` (optional text, per-visit so a repeat visitor can attend for a different company).

Surfaced everywhere a visitor appears: gate capture form (with repeat-visitor prefill), approval
card, console list + detail, console free-text search, CSV export ("Company" column), the daily
SharePoint manifest, and the new-request notification body (e.g. "Anitha Raj (Kiara Global
Services) to see …").

Deployed and live. e2e extended to 93 cases (all passing) covering company persistence, prefill,
search-by-company, and the CSV column. Verified in production: migration applied, the served bundle
carries the field, and the two pre-existing visits correctly show an empty company.

## 2026-07-24 — Notifications (Web Push + permanent history)

Alerts reach the phone's notification shade even with the app closed, and every alert is kept
forever in an in-app history. See CLAUDE.md for the contract and platform limits.

- `004_notifications.sql` — `notifications` (DELETE blocked by trigger) and `push_subscriptions`
  (one row per device, unique by endpoint, disabled rather than deleted on 404/410).
- `lib/push.js` — VAPID transport; prunes subscriptions the push service reports as gone.
- `lib/notify.js` — replaces the old `notifyAdmin()` stub. Creates rows in the caller's
  transaction; delivery is scheduled after commit and never blocks the response.
- `lib/sweeper.js` — 60s tick: escalates requests pending over 10 minutes (once each, guarded by
  `NOT EXISTS`), and retries undelivered pushes for 24 hours / 5 attempts.
- `routes/notifications.js` — history (paginated, never trimmed), unread count, read / read-all,
  subscribe / unsubscribe / test push. Every query is scoped to the requesting user.
- Frontend: service worker `push` + `notificationclick`, a bell with unread badge in `AppHeader`,
  and a notification centre that explains per device *why* alerts are or are not arriving.

**Design note.** The ordering is the whole design: record first inside the transaction, push after.
Push cannot be the source of truth — that is what makes "nothing should be lost" true when a
device is offline, uninstalled, or has revoked permission.

Removed the pending-count badge from the approvals header: it collided with the new bell badge and
the same count was already on the Pending tab.

### Verification

Twenty-five new cases in the e2e suite (88 total, all passing): fan-out to every approver and to
nobody else, per-user scoping (one user cannot read or mark another's), decision routed back to the
logging guard, check-in routed to the host only, stale broadcasts resolved but retained, unread
counting, read and read-all, database-level DELETE refusal, and device subscription upsert.

In production: the VAPID keypair was validated against Google's push service — FCM returned 410 for
a deliberately unknown endpoint rather than 401/403, which means the signature was accepted. One
minute after deploy the sweeper escalated a visit that had been pending since 11:09, creating
exactly seven notifications — one per approver, no duplicates — with retry attempts recorded and
`pushed_at` still NULL because no device has been registered yet. That is the intended behaviour:
the alerts are safe in history and will be there when the admins enable notifications.

**Still unverified:** delivery to a physical handset. That needs someone to open the app on a phone
and tap "Turn on", then "Send a test" — it cannot be proven from here.

## 2026-07-24 — SharePoint photo sync

Photos are copied to `Documents/GatePass/<YYYY-MM-DD>/` on the Dhanam Repository site
(`kiaramfi.sharepoint.com/sites/repo`), with readable filenames and a per-day `_manifest.csv`.
Cron every 15 minutes. See CLAUDE.md for the operating detail.

- `server/lib/sharepoint.js` — Graph adapter (client-credentials OAuth, PUT-to-path upload).
  Credentials come from SSM at runtime via the instance role; **no secret enters this repo.**
  Reuses the Azure app registration the wealth nightly backup already uses, which already holds
  `Files.ReadWrite.All`, so nothing new had to be granted in Azure.
- `server/scripts/sync-photos-sharepoint.js` — the sync, with `--dry-run`, `--self-test` and
  `--date=` backfill.
- `002_photo_sync.sql` — `photo_sync` tracking table making the job idempotent.

### Fixed along the way

- **Companion ordering (`003_companion_position.sql`).** Companions are inserted in a single
  transaction, so their `created_at` values tie and ordering fell back to the random UUID `id`.
  Members appeared in arbitrary order in the console and were numbered arbitrarily in SharePoint
  filenames — "member1" was whoever won a coin flip, not who the guard entered first. There is now
  an explicit `position` column, set on insert and used by every ordering.
- **Cron `PATH`.** `lib/sharepoint.js` shells out to the AWS CLI, which lives in `/usr/local/bin`;
  cron's `PATH` is `/usr/bin:/bin`. Resolving the binary by name worked interactively and would
  have failed **only from cron, and only on the first day a real visitor was logged** — because with
  nothing to upload the script returns before it ever loads credentials. Caught by running the job
  under `env -i PATH=/usr/bin:/bin`. The adapter now resolves the CLI by absolute path and the
  crontab sets `PATH` too.

### Verification

Proven end to end on the VM against a scratch database, a scratch photo directory and an isolated
`GatePass/.verify/` folder, so no production data or real folder was touched: three photos and a
manifest uploaded into the correct date folder with correct names and member numbering, contents
read back from Graph to confirm they were really stored, a second run correctly did nothing, and
every artifact was then deleted. The `photo_sync` rows matched.

## 2026-07-24 — Phase 4: Polish & ship

- PWA manifest + service worker (app-shell caching only; no offline writes in v1).
- Rate limiting on login (keyed by IP **and** username, so one guard mistyping a password cannot
  lock out a whole gate behind one NAT address), request-size caps, phone/role/input validation
  hardening, consistent error envelope, empty and error states across all screens.
- `ecosystem.config.js` (PM2, process name `gatepass`) and `deploy.sh`.
- Upgraded multer 1.x → 2.x before launch; 1.x carries known vulnerabilities and this app accepts
  file uploads from the public internet.

### Live deployment

- **URL:** https://gatepass.dhanamfinance.com (HTTP 301-redirects to HTTPS)
- **Host:** shared EC2 VM 3.110.0.79, listening on **127.0.0.1:3040** only — never on a public
  interface. Nginx is the only thing that reaches it.
- **PM2:** process `gatepass` (id 4), `pm2 save` written. Restart with `pm2 restart gatepass`;
  never `pm2 restart all` — lockerhub, odpulse-api and reports share this VM.
- **Database:** Postgres role `gatepass`, database `gatepass`, on the VM's existing cluster.
- **Photos:** `/var/gatepass/photos`, owned by `ubuntu`. **Must be added to the VM backup routine —
  it is not covered by a database dump.**
- **Nginx:** own file `/etc/nginx/sites-available/gatepass`, symlinked into `sites-enabled`.
  `client_max_body_size 25m` because a group of ten visitors uploads ten photos in one request.
- **TLS:** single-domain certbot cert `gatepass.dhanamfinance.com`, expires 2026-10-22, auto-renewing.
- **Verified no collateral impact:** every pre-existing nginx site file was checksummed before the
  change and re-verified byte-identical afterwards; all other certificates remain single-domain;
  all other sites still respond. (`dashboard.dhanamfinance.com` returns 502 — it proxies to
  port 5000, which had nothing listening before this work began and has no PM2 process.
  Pre-existing and unrelated.)
- Config backup taken at `/tmp/nginx-backup-<timestamp>` on the VM.

### Verification

63-case end-to-end suite passing against a fresh database, covering: auth and role separation,
photo access control and path traversal, visit creation with companions, repeat-visitor lookup,
the full state machine including every illegal transition, the audit trail, database-level
append-only enforcement, console filters and CSV export, and immediate revocation on deactivation.

The concurrency requirement is tested directly: two admins firing `approve` simultaneously at the
same visit produce one 200 and one 409, with exactly one `approved_by` stamped and exactly one
`APPROVED` audit event in the database.

---

## v2 candidates (out of scope for v1)

- OTP verification of the visitor's phone number.
- WhatsApp/SMS notification to the host admin — `notifyAdmin()` is stubbed in `server/lib/notify.js`.
- Multi-building / multi-gate support.
- Tamil UI toggle (all strings already isolated in `web/src/labels.ts`).
- Visitor badges / QR passes.
- Offline write support in the PWA.
