#!/usr/bin/env bash
# Deploy the committed HEAD to the paiva host from this Mac. Usage: deploy/deploy.sh
# Builds on the host, keeps the previous image tag for rollback, never touches the DB volume.
set -euo pipefail
SSH=${SSH:-$HOME/bin/ssh-hetzner-paiva}
DIR=/srv/deploy/workout
cd "$(git rev-parse --show-toplevel)"
git diff --quiet && git diff --cached --quiet || { echo "Working tree is dirty; commit first." >&2; exit 1; }
SHA=$(git rev-parse --short=12 HEAD)
echo "Deploying $SHA"
git archive --format=tar.gz HEAD | "$SSH" "set -e; mkdir -p $DIR; rm -rf $DIR/src.new; mkdir $DIR/src.new; tar -xzf - -C $DIR/src.new; rm -rf $DIR/src.prev; [ -d $DIR/src ] && mv $DIR/src $DIR/src.prev; mv $DIR/src.new $DIR/src"
"$SSH" "set -e; cd $DIR/src; GIT_SHA=$SHA docker compose --env-file $DIR/.env up -d --build --wait --wait-timeout 180; echo $SHA > $DIR/DEPLOYED; docker compose --env-file $DIR/.env ps"
curl -fsS https://workout.paiva.it/api/v1/health/ready && echo " live: $SHA"
