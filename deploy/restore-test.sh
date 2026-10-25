#!/usr/bin/env bash
# Prove a backup restores: load the newest (or given) archive into a throwaway DB, compare counts, drop it.
# Never restores over production. Usage on host: /srv/deploy/workout/src/deploy/restore-test.sh [archive]
set -euo pipefail
archive=${1:-$(ls -1t /srv/backups/workout/daily/workout-*.archive.gz | head -1)}
tmpdb="workout_restore_test_$(date -u +%Y%m%d%H%M%S)"
mongo() { docker exec -u 0 -i workout-mongo-1 "$@"; }
pw=$(sed -n 's/^password: *//p' /srv/deploy/workout/mongodump.yaml)
mongo mongorestore --quiet --config=/run/secrets/mongodump.yaml --authenticationDatabase admin --username root --archive --gzip --nsFrom 'workout.*' --nsTo "$tmpdb.*" < "$archive"
count() { mongo mongosh --quiet -u root -p "$pw" --authenticationDatabase admin "$1" --eval 'JSON.stringify(Object.fromEntries(["users","trainingPacks","catalogState","trainingSessions","bodyMeasurements"].map(c=>[c,db.getCollection(c).countDocuments()])))'; }
echo "archive:  $archive"
echo "restored: $(count "$tmpdb")"
echo "live now: $(count workout)"
mongo mongosh --quiet -u root -p "$pw" --authenticationDatabase admin "$tmpdb" --eval 'const u=db.users.findOne({},{username:1,passwordHash:1}); const p=db.trainingPacks.findOne({},{packId:1,version:1}); print("user present:", !!u, "argon2id hash:", /^\$argon2id\$/.test(u.passwordHash), "pack:", p.packId+"@"+p.version); db.dropDatabase(); print("dropped", db.getName())'
