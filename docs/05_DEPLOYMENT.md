# Deployment and operations

Destination is `training.paiva.it` on the host accessible from the user's Mac using `ssh-hetzner-paiva`. Existing access and deployment conventions are authoritative. No host reset, global cleanup, migration of other sites or replacement of an existing proxy is part of this task.

## Discover and prepare

1. Verify the current GitHub login and permissions for `paiva-it`. Check whether `training-paiva` exists before creation; use `training-paiva-personal` if the former is unrelated. Public visibility is requested. Do not create issues or send messages.
2. Resolve `ssh-hetzner-paiva` in the user's shell: it may be a command, script, function or alias. For example inspect `type ssh-hetzner-paiva` in the shell where it is defined. Use the established command/SSH config; do not invent a host IP or print private key contents.
3. Inspect host OS/architecture, Docker Compose availability, current services, networks, proxy, DNS A/AAAA for the hostname, TLS handling, ports, RAM/disk and backup arrangements. Record an appropriately redacted inventory locally. Check for an existing service at the target domain before changing its route.
4. Use a distinct Compose project, database, user, service names, volumes and app directory. Reuse an existing suitable internal MongoDB only if isolated credentials/database can be established safely. Do not upgrade a shared MongoDB or modify its security for this app.

## Suggested deployment shape

- Multi-stage Docker build using supported pinned Node LTS and compatible pinned dependencies. `pnpm --frozen-lockfile` with committed lockfile.
- React build served by NestJS from the same origin; JSON API under `/api/v1`. Unknown API routes return JSON 404; frontend routes fall back to index.html. Never ship the source `.env` or bootstrap files into the image.
- One app container running as an unprivileged user; one isolated MongoDB container if needed; authenticated Mongo access; persistent named volume; health checks and graceful shutdown. No `latest` tags in the final deployment.
- Connect the app to the existing proxy's network, or bind its port only to `127.0.0.1` when the proxy runs on the host. Publish no MongoDB host port. Document actual values rather than leaving placeholder ports in a claimed finished deployment.
- Protected runtime secret files outside Git; `.env.example` contains placeholders only. Never put bootstrap secrets in build arguments or CI variables visible to the public repository.

Prefer a simple explicit deploy script from the user's authenticated Mac. Automated deployment credentials in GitHub Actions are not required for this MVP. CI may safely run lint/typecheck/tests/build with synthetic isolated data.

## Rollout

Build and run tests locally. Create/push the reviewed public repo. Stage the application with the prior route untouched. Import the generic pack, bootstrap the one account once, and import the private profile idempotently. Ensure private files cannot be served as static assets.

Create the hostname route using the actual proxy convention. Back up the relevant proxy file first; validate config; perform a graceful reload. Ensure DNS points to the host and all published A/AAAA addresses actually serve the app. Do not modify the root domain or unrelated records. Use an already-authorized DNS tool if available; if no access exists, report the exact required record and keep other work complete.

Verify TLS/hostname, HTTP-to-HTTPS redirect, login with the requested account, reload/resume, real DB persistence across app restart, video fallback, private API blocking, backup and unrelated site availability. Do not call a localhost-only app deployed. Use temporary synthetic smoke records and remove or clearly isolate them afterward.

## Backup and restore

Reuse the current host backup scheduler/destination where possible. Default proposal: daily protected MongoDB dump, 14 daily and 8 weekly retained copies, encrypted off-host destination if already available. These are defaults for this app only, not permission to alter other backup retention. For a standalone DB, briefly block app writes during backup so a dump is consistent; do not assume `mongodump --oplog` works on standalone MongoDB. Prefer the host's established snapshot/backup method when it provides verified consistency.

Restore into a separate temporary database with isolated credentials; verify the user, pack, one synthetic training session and measurement, and application reads. Never restore over production to test. Delete temporary restore data after verification. Record time, method and result without secrets. If only a local backup is possible, say so plainly; off-host backup setup remains outstanding until a destination is available.

## Release and rollback

Record deployed commit/image digest and actual Compose/app paths. Keep the previous app image and relevant proxy config. Use additive schema changes; new code must not automatically destroy prior data. Back up before migrations. Rollback switches the app image and route if required, preserving the database volume. Do not use `docker compose down -v`, global `docker system prune` or broad process kill commands on the shared host.

## Final operational handoff

Provide tested commands for deploy/update, view sanitized logs, restart app, inspect health, run seed/import, recover/reset password privately, create backup and restore to a separate DB. Include repo URL, live URL, deployed commit, chosen package/runtime versions, active host paths, backup location classification (local/off-host), test results and any actual blockers. Keep infrastructure secrets and personal exports out of the public runbook.
