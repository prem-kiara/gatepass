#!/usr/bin/env bash
#
# GatePass deploy. Run on the VM from the repo root: ./deploy.sh
#
# This VM is shared with other apps. Everything here is scoped to gatepass:
# it never touches another PM2 process, nginx server block, or certificate.

set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling latest"
git pull --ff-only

echo "==> Installing server dependencies"
( cd server && npm ci --omit=dev )

echo "==> Building frontend"
( cd web && npm ci && npm run build )

echo "==> Running migrations"
( cd server && npm run migrate )

echo "==> Restarting PM2 process 'gatepass'"
if pm2 describe gatepass > /dev/null 2>&1; then
  pm2 restart gatepass --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save

echo "==> Health check"
PORT_VALUE="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
PORT_VALUE="${PORT_VALUE:-3040}"
for _ in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT_VALUE}/api/health" > /dev/null; then
    echo "==> Deployed. GatePass is healthy on port ${PORT_VALUE}."
    exit 0
  fi
  sleep 1
done

echo "!! Health check failed — check: pm2 logs gatepass --lines 50" >&2
exit 1
