#!/usr/bin/env bash
# Runs ON the Lightsail instance (as user aberp) when GitHub Actions dispatches
# a deploy via SSM Run Command. See .github/workflows/deploy.yml.
#
#   $1  commit SHA — used both as the release dir name and to find the
#       tarball at s3://$BUCKET_STATIC/_deploy/build-server-<sha>.tgz
#
# Env (set by the SSM dispatcher):
#   BUCKET_STATIC   S3 bucket holding the deploy artifact
#   AWS_REGION      defaults to eu-central-1
#
# Idempotent: re-running with the same SHA re-fetches and re-installs.

set -euo pipefail

SHA="${1:?usage: lightsail-deploy.sh <commit-sha>}"
BUCKET="${BUCKET_STATIC:?BUCKET_STATIC env required}"
REGION="${AWS_REGION:-eu-central-1}"

APP_USER="aberp"
HOME_DIR="/home/${APP_USER}"
RELEASE_DIR="${HOME_DIR}/releases/${SHA}"
CURRENT_LINK="${HOME_DIR}/current"
KEEP_RELEASES=5
PORT_LOCAL=3000

if [[ "$(id -un)" != "$APP_USER" ]]; then
  echo "error: must run as user '${APP_USER}', got '$(id -un)'" >&2
  exit 1
fi

log() { printf '\n[lightsail-deploy %s] %s\n' "$SHA" "$*"; }

# ---------------------------------------------------------------------------
# 1. Fetch + extract release
# ---------------------------------------------------------------------------
log "fetch release bundle from S3"
mkdir -p "$RELEASE_DIR"
TARBALL="/tmp/build-server-${SHA}.tgz"
aws s3 cp \
  "s3://${BUCKET}/_deploy/build-server-${SHA}.tgz" \
  "$TARBALL" \
  --region "$REGION"

log "extract release into ${RELEASE_DIR}"
tar -xzf "$TARBALL" -C "$RELEASE_DIR"
rm -f "$TARBALL"

# Sanity-check: the tarball must contain build/index.js, package.json, package-lock.json.
test -f "${RELEASE_DIR}/build/index.js"        || { echo "error: build/index.js missing in release" >&2; exit 1; }
test -f "${RELEASE_DIR}/package.json"          || { echo "error: package.json missing in release" >&2; exit 1; }
test -f "${RELEASE_DIR}/package-lock.json"     || { echo "error: package-lock.json missing in release" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. Install production deps
# ---------------------------------------------------------------------------
log "npm ci --omit=dev"
cd "$RELEASE_DIR"
npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 3. Capture previous release for rollback
# ---------------------------------------------------------------------------
PREVIOUS=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS=$(readlink -f "$CURRENT_LINK" || true)
fi

# ---------------------------------------------------------------------------
# 4. Atomic symlink swap + service restart
# ---------------------------------------------------------------------------
log "swap current -> ${RELEASE_DIR}"
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"

log "systemctl restart aberp-site"
sudo /bin/systemctl restart aberp-site

# ---------------------------------------------------------------------------
# 5. Health-check
# ---------------------------------------------------------------------------
log "health-check on http://127.0.0.1:${PORT_LOCAL}/healthz"
HEALTH_OK=0
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT_LOCAL}/healthz"; then
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  echo "error: health-check failed after 20s" >&2
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "  rolling back to ${PREVIOUS}" >&2
    ln -sfn "$PREVIOUS" "${CURRENT_LINK}.new"
    mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
    sudo /bin/systemctl restart aberp-site || true
  fi
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. Prune old releases (keep the last $KEEP_RELEASES)
# ---------------------------------------------------------------------------
log "prune old releases (keep last ${KEEP_RELEASES})"
cd "${HOME_DIR}/releases"
# shellcheck disable=SC2012
ls -1dt -- */ 2>/dev/null \
  | tail -n "+$((KEEP_RELEASES + 1))" \
  | while read -r old; do
    # Don't delete the currently-linked release (defensive).
    if [[ "$(readlink -f "$CURRENT_LINK")" != "${HOME_DIR}/releases/${old%/}" ]]; then
      rm -rf -- "$old"
    fi
  done

log "done — release ${SHA} live"
