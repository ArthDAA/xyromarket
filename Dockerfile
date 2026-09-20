# Single image, three deployments (blitz.cloud A41 — replaces the VPS/systemd
# plan): one "app" per Node process (web/bot/jobs), same image and repo, only
# the start command differs. Default CMD below is the web process; the bot
# and jobs apps override "Start command" in blitz.cloud's UI (see README.md).
#
# Migrations run before every process boots, on every one of the three apps —
# safe to do redundantly: `runMigrations` (src/db/migrations/run.js) takes a
# Postgres advisory lock, so if two of the three happen to boot at the same
# moment, only one actually applies anything and the others no-op.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["sh", "-c", "npm run migrate && npm run web"]
