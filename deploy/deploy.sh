#!/usr/bin/env bash
# Runs ON THE VPS, as the `xyro` deploy user — pulls the latest `main`,
# reinstalls dependencies, applies pending migrations, restarts the three
# services. Called by .github/workflows/deploy.yml over SSH on every push
# to `main`, or by hand for a manual redeploy.
#
# Requires (one-time setup, not done by this script):
#   - /opt/xyro-market is a clone of the GitHub repo, owned by `xyro`.
#   - `xyro` has a passwordless sudo rule for exactly these three restarts —
#     see README.md > "Déploiement" for the exact sudoers line.
set -euo pipefail

cd /opt/xyro-market

git pull --ff-only origin main
npm ci --omit=dev
npm run migrate

sudo systemctl restart xyro-web xyro-bot xyro-jobs

echo "Deployed $(git rev-parse --short HEAD) at $(date -Iseconds)"
