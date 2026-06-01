#!/usr/bin/env bash
# One-time bootstrap for the AWS Lightsail instance that runs ABERP-site (friboard.com)
# dynamic surface. Run as a user with sudo on a fresh Ubuntu 22.04 LTS instance.
#
# This script is idempotent for everything EXCEPT the persistent disk mkfs
# (clearly flagged below — destroys data on /dev/xvdf). Re-running on an already-
# bootstrapped instance after the disk is initialised will skip the mkfs.
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
# 4. Persistent block storage for data/quotes
#
# DESTRUCTIVE on first run: mkfs erases the attached disk. Skipped if the disk
# already has a filesystem signature, so re-running is safe after first boot.
# ---------------------------------------------------------------------------
DISK="${ABERP_DATA_DISK:-/dev/xvdf}"
MOUNTPOINT="/mnt/aberp-data"

if [[ ! -b "$DISK" ]]; then
  echo "warn: block device $DISK not present — skipping data-disk setup." >&2
  echo "      Attach a Lightsail block storage volume and re-run, or set ABERP_DATA_DISK." >&2
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
# Edit these values before starting the service.
# Generate the admin token with: openssl rand -hex 32
ABERP_SITE_ADMIN_TOKEN=
# Optional: CloudFront → Lightsail shared header. Generate the same way and
# configure it on the CloudFront Lightsail origin under "Add custom headers".
CLOUDFRONT_SHARED_SECRET=
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
ORIGIN=https://friboard.com
ABERP_SITE_QUOTE_DIR=/home/aberp/data/quotes
EOF
  sudo chmod 600 /etc/aberp-site.env
  sudo chown aberp:aberp /etc/aberp-site.env
fi

# ---------------------------------------------------------------------------
# 10. Firewall — block direct internet access to :3000; only loopback talks
# to the Node process. Nginx or CloudFront-fronted access goes via the
# instance's port 80/443 (configure separately). This bootstrap leaves the
# Node process on 127.0.0.1 only — see HOST=127.0.0.1 in the env file.
# Lightsail also has a network-level firewall in the AWS console; configure
# that to allow 22 (SSH), 80 (CloudFront origin via nginx), 443 if you
# terminate TLS on the box.
# ---------------------------------------------------------------------------
log "ufw — allow SSH only on the OS firewall; Lightsail console firewall handles HTTP/S"
sudo ufw allow OpenSSH || true
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
