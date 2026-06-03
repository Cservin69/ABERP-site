#!/usr/bin/env bash
# Deploy abenerp.com to AWS S3 + CloudFront.
# See docs/deploy.md for the full runbook and topology.
#
# Required environment variables:
#   ABERP_SITE_BUCKET  S3 bucket name (e.g. abenerp-com-www)
#   ABERP_SITE_DIST    CloudFront distribution ID
#
# Optional:
#   ABERP_SITE_REGION  defaults to eu-central-1
#   SKIP_BUILD=1       skip `npm run build` if you already built locally

set -euo pipefail

BUCKET="${ABERP_SITE_BUCKET:-}"
DIST="${ABERP_SITE_DIST:-}"
REGION="${ABERP_SITE_REGION:-eu-central-1}"

if [[ -z "$BUCKET" || -z "$DIST" ]]; then
  echo "error: ABERP_SITE_BUCKET and ABERP_SITE_DIST must be set" >&2
  echo "       see docs/deploy.md for details" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "error: aws CLI not found in PATH" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> building"
  npm run build
fi

if [[ ! -d build ]]; then
  echo "error: build/ directory missing — did the build fail?" >&2
  exit 1
fi

echo "==> syncing immutable assets to s3://${BUCKET} (region ${REGION})"
aws s3 sync build/ "s3://${BUCKET}" \
  --region "$REGION" \
  --delete \
  --cache-control 'public, max-age=31536000, immutable' \
  --exclude index.html \
  --exclude '*.html' \
  --exclude robots.txt \
  --exclude sitemap.xml

echo "==> uploading no-cache HTML and meta files"

upload_no_cache() {
  local src="$1" key="$2" mime="$3"
  if [[ -f "$src" ]]; then
    aws s3 cp "$src" "s3://${BUCKET}/${key}" \
      --region "$REGION" \
      --cache-control 'public, max-age=0, must-revalidate' \
      --content-type "$mime"
  else
    echo "warn: $src missing — skipping" >&2
  fi
}

upload_no_cache build/index.html   index.html   'text/html; charset=utf-8'
upload_no_cache build/privacy.html privacy.html 'text/html; charset=utf-8'
upload_no_cache build/imprint.html imprint.html 'text/html; charset=utf-8'
upload_no_cache build/robots.txt   robots.txt   'text/plain; charset=utf-8'
upload_no_cache build/sitemap.xml  sitemap.xml  'application/xml; charset=utf-8'

echo "==> invalidating CloudFront distribution ${DIST}"
aws cloudfront create-invalidation \
  --distribution-id "$DIST" \
  --paths '/' '/index.html' '/robots.txt' '/sitemap.xml' '/privacy' '/privacy.html' '/imprint' '/imprint.html' \
  >/dev/null

echo "==> done"
