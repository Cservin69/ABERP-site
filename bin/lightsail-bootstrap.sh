#!/usr/bin/env bash
# One-time bootstrap for the AWS Lightsail instance that runs the ABERP-site
# dynamic surface. Run as a user with sudo on a fresh Ubuntu 22.04 LTS instance.
#
# This script is idempotent for everything EXCEPT the persistent disk mkfs
# (clearly flagged below — destroys data on the attached block device). Re-
# running on an already-bootstrapped instance after the disk is initialised
# will skip the mkfs, and every other step is a no-op on second run.
#
# After running, edit /etc/aberp-site.env to fill in ABERP_SITE_ADMIN_TOKEN
# (and CLOUDFRONT_SHARED_SECRET if you configured the origin header), then:
#     sudo systemctl start aberp-site
#
# See docs/aws/lightsail-bootstrap.md for the narrative version.

set -euo pipefail

log() { printf '\n==> %s\n' "$*"; }

require_root_or_sudo() {
  if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    echo "error: must run as root or have sudo installed" >&2
    exit 1
  fi
}
require_root_or_sudo

# ---------------------------------------------------------------------------
# 1. System update + base packages
# ---------------------------------------------------------------------------
log "apt update + upgrade"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg unzip ufw logrotate

# ---------------------------------------------------------------------------
# 1b. Swap file
#
# Lightsail's Nano $3.50 plan ships 512 MB RAM, which OOM-kills `npm ci`
# during deploys. A 2 GB swap file at /swapfile fixes that without touching
# the data disk. Idempotent: skipped entirely if any swap is already active.
# ---------------------------------------------------------------------------
if [[ $(swapon --noheadings --show 2>/dev/null | wc -l) -eq 0 ]]; then
  log "create 2 GB swap file at /swapfile"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
else
  log "swap already active — skipping swap file creation"
fi

# ---------------------------------------------------------------------------
# 2. Node 20 LTS
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v20\.'; then
  log "install Node 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
node --version
npm --version

# ---------------------------------------------------------------------------
# 3. App user + directories
# ---------------------------------------------------------------------------
log "create app user (aberp) and directories"
if ! id aberp >/dev/null 2>&1; then
  sudo useradd -m -s /bin/bash aberp
fi
sudo mkdir -p /home/aberp/releases /home/aberp/logs
sudo chown -R aberp:aberp /home/aberp

# ---------------------------------------------------------------------------
# 3b. Scoped sudoers for aberp -> systemctl on aberp-site
#
# lightsail-deploy.sh (run as the aberp user via SSM) needs to restart the
# Node server after each release swap. Granting passwordless sudo only for
# the exact systemctl verbs against the aberp-site unit keeps the blast
# radius tight. Written via a temp file + visudo -c to fail loudly on any
# syntax error before installing.
# ---------------------------------------------------------------------------
log "install /etc/sudoers.d/aberp-systemctl"
SUDOERS_TMP="$(mktemp)"
cat >"$SUDOERS_TMP" <<'EOF'
# Managed by bin/lightsail-bootstrap.sh — do not edit by hand.
# Allows the aberp user to manage only the aberp-site systemd unit.
aberp ALL=(root) NOPASSWD: /usr/bin/systemctl restart aberp-site, /usr/bin/systemctl reload aberp-site, /usr/bin/systemctl start aberp-site, /usr/bin/systemctl stop aberp-site, /usr/bin/systemctl is-active aberp-site, /usr/bin/systemctl status aberp-site
EOF
if sudo visudo -c -f "$SUDOERS_TMP" >/dev/null; then
  sudo install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/aberp-systemctl
else
  echo "error: generated sudoers entry failed visudo -c — aborting" >&2
  rm -f "$SUDOERS_TMP"
  exit 1
fi
rm -f "$SUDOERS_TMP"

# ---------------------------------------------------------------------------
# 4. Persistent block storage for data/quotes
#
# DESTRUCTIVE on first run: mkfs erases the attached disk. Skipped if the disk
# already has a filesystem signature, so re-running is safe after first boot.
#
# Device naming: older Lightsail / Xen-based instances exposed the attached
# block storage as /dev/xvdf. Current Lightsail (Nitro / NVMe) exposes it as
# /dev/nvme1n1. We default to nvme1n1, fall back to xvdf, and finally try to
# auto-detect the first unmounted block device with no partition table. The
# operator can override everything with ABERP_DATA_DISK=/dev/whatever.
# ---------------------------------------------------------------------------
MOUNTPOINT="/mnt/aberp-data"

detect_data_disk() {
  if [[ -n "${ABERP_DATA_DISK:-}" ]]; then
    echo "$ABERP_DATA_DISK"
    return
  fi
  if [[ -b /dev/nvme1n1 ]]; then echo /dev/nvme1n1; return; fi
  if [[ -b /dev/xvdf ]];    then echo /dev/xvdf;    return; fi
  # Last resort: pick the first whole disk that has no children (no
  # filesystem / partitions mounted yet). lsblk -ndo NAME,TYPE,MOUNTPOINT
  # prints one row per device; we want disks with an empty mountpoint
  # whose name is not the root device.
  local root_disk candidate
  root_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null | head -n1)
  while read -r name type mp; do
    [[ "$type" == "disk" ]] || continue
    [[ -z "$mp" ]] || continue
    [[ "$name" != "$root_disk" ]] || continue
    candidate="/dev/$name"
    break
  done < <(lsblk -ndo NAME,TYPE,MOUNTPOINT)
  echo "${candidate:-}"
}

DISK="$(detect_data_disk)"

if [[ -z "$DISK" || ! -b "$DISK" ]]; then
  echo "warn: no attached data disk found (tried ABERP_DATA_DISK, /dev/nvme1n1," >&2
  echo "      /dev/xvdf, lsblk auto-detect) — skipping data-disk setup." >&2
  echo "      Attach a Lightsail block storage volume and re-run, or set" >&2
  echo "      ABERP_DATA_DISK=/dev/<name> explicitly." >&2
else
  log "configure persistent data disk on $DISK -> $MOUNTPOINT"
  if ! sudo blkid "$DISK" >/dev/null 2>&1; then
    echo "  - no existing filesystem found; running mkfs.ext4 (DESTRUCTIVE)"
    sudo mkfs.ext4 -F "$DISK"
  else
    echo "  - existing filesystem detected on $DISK; skipping mkfs"
  fi
  sudo mkdir -p "$MOUNTPOINT"
  if ! mountpoint -q "$MOUNTPOINT"; then
    sudo mount "$DISK" "$MOUNTPOINT"
  fi
  if ! grep -qE "^${DISK}[[:space:]]" /etc/fstab; then
    echo "${DISK} ${MOUNTPOINT} ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab >/dev/null
  fi
  sudo mkdir -p "${MOUNTPOINT}/quotes"
  sudo chown -R aberp:aberp "$MOUNTPOINT"
  if [[ ! -L /home/aberp/data ]]; then
    sudo -u aberp ln -sfn "$MOUNTPOINT" /home/aberp/data
  fi
fi

# ---------------------------------------------------------------------------
# 5. SSM Agent — registers this Lightsail box with AWS Systems Manager so the
# GitHub Actions deploy can send-command into it without an SSH key.
# Lightsail is not natively SSM-managed; we register it as a hybrid instance.
# Activation code/id come from `ssm create-activation` run in the AWS console
# (see operator-checklist.md step 6) and are passed via env when bootstrapping.
# ---------------------------------------------------------------------------
log "install Amazon SSM Agent (snap)"
if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
  sudo snap install amazon-ssm-agent --classic
fi

if [[ -n "${SSM_ACTIVATION_CODE:-}" && -n "${SSM_ACTIVATION_ID:-}" ]]; then
  log "register instance with SSM (hybrid activation)"
  sudo /snap/amazon-ssm-agent/current/amazon-ssm-agent \
    -register \
    -code "$SSM_ACTIVATION_CODE" \
    -id "$SSM_ACTIVATION_ID" \
    -region "${AWS_REGION:-eu-central-1}" \
    -y
else
  echo "note: SSM_ACTIVATION_CODE/SSM_ACTIVATION_ID not set; skipping registration." >&2
  echo "      Re-run with those env vars after creating a hybrid activation." >&2
fi
sudo snap start amazon-ssm-agent || true

# ---------------------------------------------------------------------------
# 6. AWS CLI v2 (needed by lightsail-deploy.sh to pull release tarballs from S3)
# ---------------------------------------------------------------------------
if ! command -v aws >/dev/null 2>&1; then
  log "install AWS CLI v2"
  TMPDIR=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" \
    -o "$TMPDIR/awscliv2.zip"
  unzip -q "$TMPDIR/awscliv2.zip" -d "$TMPDIR"
  sudo "$TMPDIR/aws/install"
  rm -rf "$TMPDIR"
fi
aws --version

# ---------------------------------------------------------------------------
# 7. Install lightsail-deploy.sh into the app user's home
# ---------------------------------------------------------------------------
log "install lightsail-deploy.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo install -m 0755 -o aberp -g aberp \
  "${SCRIPT_DIR}/lightsail-deploy.sh" /home/aberp/lightsail-deploy.sh

# ---------------------------------------------------------------------------
# 8. systemd unit for the Node server
# ---------------------------------------------------------------------------
log "install systemd unit"
SERVICE_SRC="${SCRIPT_DIR}/../docs/aws/aberp-site.service"
if [[ -f "$SERVICE_SRC" ]]; then
  sudo install -m 0644 -o root -g root "$SERVICE_SRC" /etc/systemd/system/aberp-site.service
  sudo systemctl daemon-reload
  sudo systemctl enable aberp-site
else
  echo "error: $SERVICE_SRC missing — run this script from a checkout of ABERP-site" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 9. Env file template
# ---------------------------------------------------------------------------
log "write /etc/aberp-site.env template"
if [[ ! -f /etc/aberp-site.env ]]; then
  sudo tee /etc/aberp-site.env >/dev/null <<'EOF'
# Edit these values before starting the service. This file is the systemd
# EnvironmentFile referenced by /etc/systemd/system/aberp-site.service.

# --- Admin / inter-service auth -------------------------------------------
# Generate the admin token with: openssl rand -hex 32
ABERP_SITE_ADMIN_TOKEN=
# Optional: CloudFront → Lightsail shared header. Generate the same way and
# configure it on the CloudFront Lightsail origin under "Add custom headers".
CLOUDFRONT_SHARED_SECRET=

# --- Process / network ----------------------------------------------------
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
# adapter-node uses these to reconstruct the request origin per-request when
# behind a reverse proxy (CloudFront). Preferred over a fixed ORIGIN= because
# it tolerates www-vs-apex / http-vs-https mismatches without redeploying.
# CloudFront forwards both headers when configured to forward all viewer
# headers, which is the default for the dynamic Lightsail origin behaviour.
PROTOCOL_HEADER=x-forwarded-proto
HOST_HEADER=x-forwarded-host
# If you need to pin the origin instead (e.g. while debugging CSRF 403s),
# uncomment and set ORIGIN= to the exact public URL the browser sees. Setting
# ORIGIN= takes precedence over PROTOCOL_HEADER/HOST_HEADER in adapter-node.
# ORIGIN=https://abenerp.com

# --- Quote pipeline -------------------------------------------------------
ABERP_SITE_QUOTE_DIR=/home/aberp/data/quotes
# Cap matching the in-handler MAX_TOTAL_BYTES in src/routes/api/quote/+server.ts.
# adapter-node defaults to 512 KB which silently 413s every CAD upload.
BODY_SIZE_LIMIT=52428800

# --- Customer-facing quote status (PR-L) ----------------------------------
# Required: HMAC key that signs /q/<id>?t=<token> status URLs. Without it,
# every quote-confirmation email returns 503. Rotate by replacing this value;
# every previously-issued link becomes invalid.
#   QUOTE_STATUS_SIGNING_KEY=$(openssl rand -hex 32)
QUOTE_STATUS_SIGNING_KEY=
# Public-facing base URL of this deployment (no trailing slash). Single source
# of truth for: operator + customer transactional emails, dynamic sitemap.xml /
# robots.txt, canonical + og:url meta, and the Origin allowlist in
# src/lib/server/origin-check.ts. Defaults to https://abenerp.com in code if
# unset, but pin it explicitly so staging boxes never email prod URLs.
# PR-Q consolidated this with the legacy ABERP_SITE_PUBLIC_BASE_URL variant;
# only this name is honoured now.
ABERP_SITE_PUBLIC_URL=https://abenerp.com

# --- Transactional email (PR-K) -------------------------------------------
# SMTP relay for the customer confirmation + operator alert that fire on
# quote submission. With SMTP_HOST unset the send path no-ops gracefully
# (logs only), so leaving these blank is a valid "don't send mail yet" mode.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
# RFC-5322 From header, e.g. 'ABENERP Quotes <quotes@abenerp.com>'
SMTP_FROM=
# Inbox that receives the new-quote operator alert. Falls back to SMTP_FROM
# if unset.
ABERP_SITE_OPERATOR_EMAIL=
EOF
  sudo chmod 600 /etc/aberp-site.env
  sudo chown aberp:aberp /etc/aberp-site.env
fi

# ---------------------------------------------------------------------------
# 10. Firewall — Ubuntu 22.04's ufw is active by default with only SSH
# allowed. Both 3000 (the Node listener that CloudFront's Lightsail origin
# targets directly) and 80 (so Certbot HTTP-01 / future ACME validation
# works if we ever terminate TLS on the box) need explicit allows; without
# them ufw silently drops connections even though the Lightsail console
# firewall lets them through. ufw allow is idempotent.
# ---------------------------------------------------------------------------
log "ufw — allow SSH, HTTP, and the Node listener on :3000"
sudo ufw allow OpenSSH || true
sudo ufw allow 80/tcp || true
sudo ufw allow 3000/tcp || true
sudo ufw --force enable || true
sudo ufw status verbose || true

# ---------------------------------------------------------------------------
# 11. Logrotate for the Node process logs
# ---------------------------------------------------------------------------
log "logrotate config"
sudo tee /etc/logrotate.d/aberp-site >/dev/null <<'EOF'
/home/aberp/logs/*.log /home/aberp/logs/*.err {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su aberp aberp
}
EOF

cat <<'EOF'

bootstrap complete.

next steps:
  1. Edit /etc/aberp-site.env and fill ABERP_SITE_ADMIN_TOKEN
     (openssl rand -hex 32).
  2. Optionally set CLOUDFRONT_SHARED_SECRET (must match the header configured
     on the CloudFront Lightsail origin).
  3. The first deploy will populate /home/aberp/current via SSM. Until then,
     `systemctl start aberp-site` will fail because there is no release yet.
  4. Trigger the first deploy from GitHub Actions (workflow_dispatch).
  5. Once green, `curl http://127.0.0.1:3000/` from the Lightsail box.

EOF
