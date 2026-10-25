# Workout

Personal training log at **https://workout.paiva.it** — single user, phone-first. The source is public; the data is not.

- `apps/web` — React 19 + TypeScript + Vite SPA (Today, Plans, Workout, History, Weight, Settings).
- `apps/api` — NestJS 12 + Mongoose 9 on Node 24 LTS. Serves the built SPA and `/api/v1` from one container.
- `packages/contracts` — shared types and pure logic (phase application, kg→grams, DST-safe local time, volume).
- `data/training-pack.v1.json` — the seed plans; `contracts/training-pack.schema.json` is the import format.
- `docs/` — product, data model, API, security, deployment and acceptance specs this app implements.

## How it works (short)

- Plans live in MongoDB as immutable, versioned *packs*. Import a new pack (Settings → Import plans, or the CLI) to add plans; no code change.
  Same pack/version + same content is a no-op, different content is a 409, and broken references fail before anything is activated.
- Starting a workout snapshots the plan, exercises and videos into the session and applies the program phase
  (sets = min(listed, cap); RIR = elementwise max of item and phase). Later plan versions never touch old sessions.
- Every workout edit is a typed operation with an operation ID and expected revision, applied as one atomic
  single-document write. Replays are idempotent; stale tabs get *Conflict - review*. The browser keeps a small
  outbox so sets survive refreshes and short disconnections.
- Weights are integer grams. Paired dumbbells are entered as kg **per dumbbell** (count 2); goblet squats as the one
  dumbbell; push-ups are bodyweight with no invented load. Left/right sides are separate records.
- Times are stored as UTC plus the original IANA timezone, local date and offset; date-only self-reports stay date-only.
- Auth: Argon2id (m=64 MiB, t=3, p=1), opaque session token in an HttpOnly `__Host-` cookie with only its SHA-256 in
  MongoDB, CSRF token + exact Origin check on every mutation, login rate limits, Helmet CSP. No registration endpoint.

## Develop

```sh
pnpm install
docker run -d --name workout-test-mongo -p 127.0.0.1:27118:27017 mongo:8.0.34
pnpm build
# API on :3000 (serves apps/web/dist too); `pnpm --filter @workout/web dev` for Vite on :5173 with a proxy
cd apps/api && MONGO_URI=mongodb://127.0.0.1:27118/workout_dev COOKIE_SECURE=false \
  APP_ORIGIN=http://localhost:5173,http://localhost:3000 node dist/main.js
node dist/cli.js import-pack ../../data/training-pack.v1.json          # same env
printf 'BOOTSTRAP_USERNAME=demo\nBOOTSTRAP_PASSWORD=demo-password-123\n' | node dist/cli.js bootstrap-user
```

Checks (all use synthetic users and throwaway databases):

```sh
pnpm validate:pack   # handoff validator over the seed
pnpm lint && pnpm typecheck
pnpm test            # contracts unit tests + API integration tests against real MongoDB (TEST_MONGO_URI, default :27118)
pnpm e2e             # Playwright at 360px + desktop against the production build
```

## Operations (host reached with `~/bin/ssh-hetzner-paiva`)

Layout: `/srv/deploy/workout/{src,src.prev,.env,mongodump.yaml,backup.sh,DEPLOYED}`; Compose project `workout`
(`workout-app-1`, `workout-mongo-1`, volume `workout_mongo_data`, network 172.31.250.0/24). The app listens on
`127.0.0.1:3010`; host nginx (`/etc/nginx/sites-available/workout.paiva.it`) terminates TLS (certbot, nginx plugin).
MongoDB publishes no port. `.env` and `mongodump.yaml` are root-only and never in Git.

```sh
deploy/deploy.sh                                   # deploy committed HEAD (builds on host, waits for health)
H=~/bin/ssh-hetzner-paiva; C='cd /srv/deploy/workout/src && docker compose --env-file ../.env'
$H "$C ps"                                         # status + health
$H "$C logs --tail 100 app"                        # logs (no bodies, passwords or cookies are logged)
$H "$C restart app"
curl -s https://workout.paiva.it/api/v1/health/ready
$H "$C exec -T app node dist/cli.js import-pack /app/data/training-pack.v1.json"     # seed (idempotent)
$H "$C exec -T app node dist/cli.js import-pack /dev/stdin" < my-pack.json            # any pack file
$H "$C exec -T app node dist/cli.js bootstrap-user" < bootstrap.env                   # no-op if the user exists
$H "$C exec -T app node dist/cli.js import-profile" < profile.private.json            # idempotent by profileImportKey
read -rs PW && printf '%s\n' "$PW" | $H "$C exec -T app node dist/cli.js reset-password <username>"; unset PW  # revokes all sessions
$H /srv/deploy/workout/backup.sh                   # backup now (cron runs it daily 03:17 UTC)
$H /srv/deploy/workout/src/deploy/restore-test.sh  # restore newest backup into a temp DB, compare, drop
```

Rollback: `$H "cd /srv/deploy/workout/src.prev && GIT_SHA=<previous sha> docker compose --env-file ../.env up -d --no-build app"`
(previous images stay tagged `workout-app:<sha>`; the DB volume is never removed — no `down -v`).

Backups are local to the host (`/srv/backups/workout`, root-only, 14 daily + 8 weekly). There is no off-host copy yet.

## Adding plans

See `docs/FUTURE_PLAN_REQUEST.md`. Keep exercise IDs stable, bump definition versions for changes and the pack version
for any change, keep packs self-contained, then import via Settings → Import plans (preview first).
