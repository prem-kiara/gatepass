# GatePass — Visitor & Gate Monitoring System

Visitor logging at the gate, broadcast approval to all admins (first decision wins),
and a full audit trail for the superadmin.

## Stack

- **Runtime:** Node.js 20+, CommonJS. Single Express app serves both `/api/*` and the built React SPA.
- **Frontend:** React 18 + Vite + Tailwind CSS 3, mobile-first. Built to `web/dist`, served by Express.
- **Database:** PostgreSQL. Plain numbered SQL migrations in `server/migrations/`, run by `server/migrate.js`. No ORM — `pg` with parameterized queries only.
- **Auth:** username + password (bcryptjs), JWT in an httpOnly cookie (`gp_token`). 12h expiry for SECURITY, 7d for ADMIN/SUPERADMIN. Role enforced in middleware on every route.
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
