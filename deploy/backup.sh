#!/usr/bin/env bash
# Daily MongoDB dump of the workout DB (installed at /srv/deploy/workout/backup.sh, run by /etc/cron.d/workout-backup).
# Keeps 14 daily + 8 weekly copies under /srv/backups/workout (root-only). Local disk only: NOT off-host.
set -euo pipefail
umask 077
DEST=/srv/backups/workout
mkdir -p "$DEST/daily" "$DEST/weekly"
ts=$(date -u +%Y-%m-%dT%H%M%SZ)
out="$DEST/daily/workout-$ts.archive.gz"
# Credentials via a root-only config file mounted read-only, never on the command line.
docker exec -u 0 workout-mongo-1 mongodump --quiet --config=/run/secrets/mongodump.yaml --authenticationDatabase admin --username root --db workout --archive --gzip > "$out.tmp"
mv "$out.tmp" "$out"
[ "$(date -u +%u)" = 7 ] && cp "$out" "$DEST/weekly/"
find "$DEST/daily" -name 'workout-*.archive.gz' -mtime +14 -delete
ls -1t "$DEST/weekly"/workout-*.archive.gz 2>/dev/null | tail -n +9 | xargs -r rm -f
echo "backup ok: $out ($(stat -c %s "$out") bytes)"
