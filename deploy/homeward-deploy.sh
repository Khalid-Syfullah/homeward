#!/usr/bin/env bash
# Run on the EC2 instance as the ubuntu user by the Deploy workflow (via AWS SSM).
# Usage: [REPO_URL=...] homeward-deploy.sh <git-ref-or-sha>
#
# Builds the ref into a fresh release directory, switches the `current` symlink, restarts the app
# with pm2, health-checks it, and restores the previous release if anything fails after the switch.
#
# Homeward takes over the slot the orange-story site used: the same app directory, the same pm2
# ecosystem file (so the same app name and port 3000) and the same nginx proxy for
# production.khalidsyfullah.com. Nothing on the server has to change. The orange-story release that
# was live stays in releases/ (the newest 5 are kept), so it can be put back; see deploy/README.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Khalid-Syfullah/homeward.git}"
APP="${HOMEWARD_APP_DIR:-/var/www/orange}"
REF="${1:-main}"
KEEP=5
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS="--max-old-space-size=1536"

[ -d "$APP" ] || { echo "App directory $APP does not exist"; exit 1; }
[ -f "$APP/ecosystem.config.cjs" ] || { echo "$APP/ecosystem.config.cjs is missing"; exit 1; }
command -v pm2 >/dev/null || { echo "pm2 is not on PATH"; exit 1; }

cd "$APP"
mkdir -p releases
REL="$APP/releases/$(date +%Y%m%d%H%M%S)"
PREV=""
if [ -L current ]; then PREV="$(readlink -f current)"; fi # empty on the very first deploy
SWITCHED=0

# Runs on every exit. On failure it restores the previous release if the
# `current` symlink was already switched, and only then removes the new release.
on_exit() {
  local rc=$?
  trap - EXIT
  set +e
  if [ "$rc" -ne 0 ]; then
    echo "Deploy failed (exit $rc)"
    if [ "$SWITCHED" -eq 1 ]; then
      if [ -n "$PREV" ] && [ -d "$PREV" ]; then
        echo "Restoring previous release: $PREV"
        ln -sfn "$PREV" "$APP/current.tmp"
        mv -Tf "$APP/current.tmp" "$APP/current"
        (cd "$APP" && pm2 startOrReload ecosystem.config.cjs --update-env) \
          || echo "WARNING: pm2 could not reload the previous release"
        rm -rf "$REL"
      else
        echo "No previous release to restore; keeping $REL"
      fi
    else
      rm -rf "$REL"
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "==> Previous release: ${PREV:-none}"
echo "==> Fetching $REF from $REPO_URL"
git init -q "$REL"
cd "$REL"
git remote add origin "$REPO_URL"
git fetch -q --depth 1 origin "$REF"
git checkout -q FETCH_HEAD
SHA="$(git rev-parse --short HEAD)"

# The real art is committed (public/frames, art/source/audio); a checkout without it would ship placeholders.
[ -f public/frames/c01-follow/manifest.json ] || { echo "public/frames is missing from $SHA"; exit 1; }
grep -Eq '"placeholder": *false' public/frames/c01-follow/manifest.json || { echo "c01-follow holds placeholder frames, not the real art"; exit 1; }

echo "==> Building $SHA"
npm ci --no-audit --no-fund --fetch-retries=6 --fetch-retry-mintimeout=15000 --fetch-retry-maxtimeout=120000 --maxsockets=4
npm run build

echo "==> Activating"
SWITCHED=1
ln -sfn "$REL" "$APP/current.tmp"
mv -Tf "$APP/current.tmp" "$APP/current"
cd "$APP"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save >/dev/null

echo "==> Health check"
ok=0
code=000
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)"
  if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "Health check failed (last status $code)"
  exit 1 # the EXIT trap restores the previous release
fi
# The page being up is not enough: the frames must come from this release too.
fcode="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/frames/c01-follow/manifest.json || true)"
if [ "$fcode" != "200" ]; then
  echo "Frames are not served (HTTP $fcode)"
  exit 1
fi

echo "==> Pruning old releases"
ls -1dt "$APP"/releases/* | tail -n +$((KEEP + 1)) | xargs -r rm -rf
trap - EXIT
echo "Deployed $SHA OK"
