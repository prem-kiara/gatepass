# GatePass — Visitor & Gate Monitoring System

Visitor logging at the gate, broadcast approval to all admins (first decision wins),
and a full audit trail for the superadmin.

## Stack

- **Runtime:** Node.js 20+, CommonJS. Single Express app serves both `/api/*` and the built React SPA.
- **Frontend:** React 18 + Vite + Tailwind CSS 3, mobile-first. Built to `web/dist`, served by Express.
- **Database:** PostgreSQL. Plain numbered SQL migrations in `server/migrations/`, run by `server/migrate.js`. No ORM — `pg` with parameterized queries only.
- **Auth:** JWT in an httpOnly cookie (`gp_token`), 12h for SECURITY and 7d for ADMIN/SUPERADMIN, role enforced in middleware on every route. Three ways to prove identity, all authenticating the *owner* and no one else:
  - **Password** (bcryptjs) — the backup for everyone.
  - **PIN** (guards) — 6 digits, bcrypt-hashed, name-picker sign-in on the shared gate phone. Wrong-PIN lockout (5 tries → 15 min, that guard only). Superadmin can *reset* to a one-time PIN (forces a change, logged) but never read or reuse one.
  - **Passkey** (admins) — WebAuthn / Face ID / fingerprint via `@simplewebauthn`. Only a public key is stored; the biometric never reaches the server. `rpId`/`origin` from `WEBAUTHN_*` config (default production).
  - Every sign-in (with method), failed attempt, PIN change and reset is written to **`auth_events`** — append-only, DELETE blocked by trigger, same as `visit_events`. This is the "no foulplay" ledger. Users manage their own credentials at `/settings`; the superadmin reads the whole ledger in Console → Security.

**The four rules that make the auth model hold.** Break any one and the audit trail stops meaning anything:

1. **A credential proves its owner and nobody else.** PINs are peppered (`PIN_PEPPER`) then bcrypt-hashed; passkeys store only a public key. Nothing readable, by anyone, including the superadmin.
2. **Restore access, never borrow it.** The superadmin's reset issues a *one-time* PIN and sets `must_change_pin`. That flag is enforced in `requireAuth` itself (chained, so a new route cannot forget it) — a temp-PIN session may only read `/auth/me`, set a PIN, or log out. Without that gate the resetting admin, who knows the temp PIN, could drive the API as the guard.
3. **A credential change ends other sessions.** Every token carries `token_version`; changing a password/PIN, an admin reset, or removing a passkey bumps it. The caller's own cookie is re-issued in the same response so they stay signed in — if you add a new credential-changing route, do both.
4. **Failures are logged, not just successes.** Including the awkward ones: attempts during a lock, against deactivated accounts, and rejected passkeys. A ledger that only records what worked cannot show you an attack.

Tripwires (`lib/notify.js` → `securityAlert`, and the sweeper) notify superadmins on PIN locks, resets, and bursts of failed sign-ins. Two burst checks, because they see different things: `alertFailedBursts` groups by **user** (one account under pressure), `alertSuspiciousSources` groups by **IP** (probing usernames that do not exist, or one password sprayed across accounts — neither of which the per-user check can see, since probing rows have no `user_id` and spraying leaves one failure per account). The per-source check is deliberately tuned not to fire on the shared gate phone: a guard fumbling their own PIN resolves to a real user, and it takes three *different* accounts from one address to read as spraying. The shared gate phone locks itself after 10 idle minutes and requires the guard's own PIN to resume.
- **Photos:** captured in-browser, compressed client-side (max edge 1024px, JPEG ~80%), uploaded via multer (memory), normalized and EXIF-stripped by sharp, written to `PHOTO_DIR` with UUID filenames. Served **only** through the authenticated route `GET /api/photos/:filename` — never as public static files.

## Layout

```
gatepass/
├── server/
│   ├── index.js          Express bootstrap, serves web/dist + /api
│   ├── db.js             pg pool + tx helper
│   ├── migrate.js        numbered-migration runner
│   ├── seed.js           idempotent superadmin seed
│   ├── migrations/       001_init.sql ...
│   ├── middleware/       auth.js, requireRole.js, upload.js, errors.js
│   └── routes/           auth.js, visits.js, approvals.js, admin.js, photos.js
├── web/src/
│   ├── pages/            Login, Gate, Approvals, Console/*
│   ├── components/
│   ├── lib/              api.js, auth.jsx, image.js
│   └── labels.ts         ALL user-facing strings (future Tamil i18n)
├── ecosystem.config.js   PM2
└── deploy.sh
```

## Conventions

- **Every user-facing string goes in `web/src/labels.ts`.** No hardcoded copy in components — Tamil translations get dropped in later.
- **Every state change writes a `visit_events` row in the same transaction** as the change itself. That table is append-only, enforced by a DB trigger.
- **First-approval-wins:** decision endpoints use `UPDATE visits SET ... WHERE id = $1 AND status = 'PENDING' RETURNING *`. Zero rows returned means someone already decided → respond `409` with the existing decision so the loser's screen updates instead of erroring.
- Security screens must be usable by a 55-year-old on a cheap Android phone in sunlight: 48px+ touch targets, 18px+ base font, high contrast, no hamburger menus.
- Phone numbers are optional. When present they are validated as 10-digit Indian mobile (a `+91`/`0` prefix is accepted) and stored normalized to 10 digits.
- Users are **deactivated, never deleted** — audit history must stay resolvable.

## Roles

| | SECURITY | ADMIN | SUPERADMIN |
|---|---|---|---|
| Log visitor, check in/out, own gate log | ✅ | — | — |
| Approve/reject (shared queue, first wins) | — | ✅ | ✅ |
| Visit history | — | own decisions | all |
| Create/deactivate users, reports, audit | — | — | ✅ |

## Visit state machine

```
PENDING ──approve──▶ APPROVED ──check-in──▶ INSIDE ──check-out──▶ CHECKED_OUT
   └─────reject─────▶ REJECTED
```

## Run locally

```bash
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, PHOTO_DIR
cd server && npm install
cd ../web && npm install
cd ../server && npm run migrate && npm run seed
npm run dev                   # API on :3040
cd ../web && npm run dev      # Vite on :5173, proxies /api to :3040
```

Production serves the built SPA from the same Express process — there is no separate frontend server.

## Tests

```bash
./test/e2e.sh
```

63 end-to-end cases over the real HTTP API. **It drops and recreates the database named by
`GATEPASS_TEST_DB` (default `gatepass_dev`) — never point that at production.** It starts its own
server on port 3040, so stop any local instance first.

The case that matters most is the approval race: two admins `POST /approve` on the same visit
concurrently, and the suite asserts one 200, one 409, exactly one `approved_by` stamped, and
exactly one `APPROVED` row in `visit_events`. If you touch the decision path, run this.

## Real-time updates (Server-Sent Events)

Screens update the instant something changes, without a manual refresh. `GET /api/events` is an
authenticated SSE stream; `lib/events.js` is an in-process bus that fans out to every open stream.

- Events are **hints, not state**: `approvals_changed`, `gate_changed`, `notification`. The client
  reacts by re-fetching the relevant endpoint (`web/src/lib/live.jsx` → `useLiveEvent`). A missed
  event self-heals on the next one, and the existing polling stays as a fallback — so a dropped SSE
  connection degrades to "updates a few seconds slower", never "stuck".
- Scope: `approvals_changed` → ADMIN/SUPERADMIN, `gate_changed` → SECURITY, `notification` →
  specific user ids. A connection receives an event if its role or id matches.
- Published **after** the DB commit (in the routes and the sweeper), so a client that re-fetches on
  the hint always sees committed state.
- **Single PM2 instance** is assumed — a plain EventEmitter reaches every connection. Running
  multiple instances would need a shared pub/sub behind `lib/events.js`; nothing else would change.
- No nginx change was needed: the response sets `X-Accel-Buffering: no` (nginx streams it through
  unbuffered) and pings every 25s to stay under the 120s proxy read timeout.

## Notifications

Two layers, and the distinction matters:

1. **The record** — a row in `notifications`, written **inside the same transaction** as the event
   that caused it. This is the durable part. `DELETE` is blocked by a trigger, so history is
   permanent, exactly like `visit_events`.
2. **The delivery** — a Web Push to the user's devices, attempted only *after* that commit and
   never awaited by the HTTP response. Push is lossy by nature (device offline, permission revoked,
   push service down), so it is treated as best-effort. `lib/sweeper.js` retries anything with
   `pushed_at IS NULL` for 24 hours, up to 5 attempts.

Never create a notification outside the caller's transaction — an alert that survives a rolled-back
visit, or a visit with no alert, is worse than either alone.

| Event | Recipients |
|---|---|
| New request | every active ADMIN + SUPERADMIN (matches the shared queue) |
| Approved / rejected | the SECURITY user who logged it |
| Checked in | the host admin only |
| Pending > 10 min | every approver, once, via the sweeper |

When one admin decides, the others' broadcast is marked `resolved_at` — **not deleted**. Their
history shows it as "Handled" instead of sending them to a queue the visit has already left.

```bash
npm run vapid    # generate a keypair; put both lines in .env, then restart
```

Rotating VAPID keys invalidates every existing device subscription and silently stops delivery
until each user re-enables. Keep the pair stable once devices are registered.

Without VAPID keys the app still runs and still records everything — only the phone's notification
shade goes quiet, and the server logs a warning at startup.

**Platform limits worth knowing before debugging "it doesn't work":**
- Android/Chrome: works installed or in-browser.
- iOS/Safari: **only** once the app is on the Home Screen (iOS 16.4+). In a Safari tab `PushManager`
  does not exist. `web/src/lib/push.js` reports this as `needs-install` and the UI tells the user to
  install rather than showing a generic failure.
- The permission prompt must originate from a real tap.

## SharePoint photo sync

Visitor photos are copied to the Dhanam Repository SharePoint site, filed by visit date:

```
Documents/GatePass/2026-07-24/0930_Suresh-Kumar_a1b2c3d4.jpg
Documents/GatePass/2026-07-24/0930_Suresh-Kumar_a1b2c3d4_member1_Lakshmi.jpg
Documents/GatePass/2026-07-24/_manifest.csv
Documents/GatePass/2026-07-25/...
```

```bash
npm run sync:photos -- --dry-run     # show what would upload, upload nothing
npm run sync:photos                  # upload everything outstanding
npm run sync:photos -- --self-test   # prove auth/upload/delete, touches no visitor data
npm run sync:photos -- --date=2026-07-24   # backfill one visit date
```

Runs from cron every 15 minutes (`crontab -l` on the VM).

- **A photo is filed under the date of its visit in gate-local time, not the date the sync ran.**
  A retry, a late run, or a backfill therefore all land in the same correct day's folder.
- **Idempotent** via the `photo_sync` table: only photos with no row there are uploaded, and the
  row is written after the upload succeeds. A photo missing from disk is reported and left
  unmarked rather than recorded as synced, so it stays visible instead of being silently dropped.
- Graph's PUT-to-path creates the date folder on that day's first upload — there is no separate
  create-folder call to race on.
- `_manifest.csv` is regenerated from the database on every run, not appended, so it stays correct
  when a visit is approved or checked out after its photo was already uploaded.

**Credentials are never stored in this repo.** They are read at runtime from AWS SSM
(`/dhanam/wealth/SHAREPOINT_*`, override with `SHAREPOINT_SSM_PATH`) using the EC2 instance role,
reusing the Azure app registration the wealth backup already uses — it already holds the
application permission `Files.ReadWrite.All`. Setting the `SHAREPOINT_*` env vars overrides SSM,
which is what makes local dry-running possible with no AWS access.

Note for anything else that shells out on this VM: cron's `PATH` is `/usr/bin:/bin`, but the AWS
CLI lives in `/usr/local/bin`. `lib/sharepoint.js` resolves the binary by absolute path for that
reason, and the crontab also sets `PATH` explicitly.

## Deployment (EC2 3.110.0.79, shared VM)

This VM hosts other apps (lockerhub, odpulse, reports, wealth, dashboard, cb).
**Do not touch their nginx server blocks, their PM2 processes, or their certbot certificates.**

- GatePass listens on **127.0.0.1:3040** only (ports 3001/3010/3020/3030/8080/8801 belong to other apps).
- PM2 process name: **`gatepass`**. Use `pm2 restart gatepass` — never `pm2 restart all`.
- Nginx: its own file `/etc/nginx/sites-available/gatepass` symlinked into `sites-enabled`. Nothing else is edited.
- Certbot: `sudo certbot --nginx -d gatepass.dhanamfinance.com` — a **single-domain** cert named `gatepass.dhanamfinance.com`. Never pass `-d` for another app's domain, and never expand an existing cert.
- Photos live at `/var/gatepass/photos` — include in the VM backup routine.
- Deploy: `./deploy.sh` (git pull → npm ci → build → migrate → `pm2 restart gatepass`).

Always run `sudo nginx -t` before `sudo systemctl reload nginx`, and reload (never restart) so the other sites don't drop connections.

## Keeping docs current

`STATE.md` is the running changelog — append an entry on every change. Keep this file accurate when stack or conventions shift.
