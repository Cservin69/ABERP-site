# Lightsail bootstrap — narrative

The dynamic surface (`/quote`, `/api/*`, `/admin/*`) runs on a single AWS
Lightsail Linux instance in `eu-central-1` (Frankfurt). This document is the
narrative companion to `bin/lightsail-bootstrap.sh` — read this once, then run
the script.

## Why Lightsail, not ECS / App Runner / a container service

See `docs/deploy.md` "Phase 2 — dynamic surface". Short version:

- Lightsail instance + attached block storage gives a real POSIX filesystem
  underneath `data/quotes/` — critical for the quote-intake durability story.
  Lightsail container service has no persistent volumes.
- A nano plan ($3.50/mo) comfortably runs the Node server at v1 traffic levels.
- One box, one systemd unit, one log file — operationally simpler than ECS for
  this size of workload.

## Provisioning recipe

### 1. Create the instance

Lightsail console → Create instance:

- Region: **eu-central-1** (Frankfurt — closest EU GDPR-resident region with
  full CloudFront origin support).
- Platform: **Linux/Unix**.
- Blueprint: **OS Only → Ubuntu 22.04 LTS**.
- Instance plan: **Nano — $3.50/mo** (512 MB RAM, 20 GB SSD, 1 TB transfer).
- Instance name: `aberp-site`.
- (Optional) Add the SSH key you want to use; otherwise Lightsail's default key
  pair is generated and downloadable from Account → SSH keys.

### 2. Attach a static IP

Networking → Static IPs → Create static IP → attach to `aberp-site`. The
static IP becomes the CloudFront custom-origin target.

### 3. Attach block storage for persistent data

Storage → Create disk:

- Region: same as the instance.
- Size: **20 GB** (cheap headroom for v1 quote volume; resize later if needed).
- Name: `aberp-site-data`.
- Attach to: `aberp-site`. Mounts as `/dev/xvdf`.

### 4. SSH in and clone the repo

```sh
ssh ubuntu@<static-ip>            # or the appropriate user / key
git clone https://github.com/Cservin69/ABERP-site.git
cd ABERP-site
```

### 5. Create a Systems Manager hybrid activation (one-time)

Lightsail instances are not natively SSM-managed. We register them as
"hybrid" instances so GitHub Actions can `aws ssm send-command` into them
without an SSH key. In the AWS Console:

- Systems Manager → Hybrid Activations → Create activation.
- Activation description: `aberp-site-lightsail`.
- IAM role: pick the AWS-managed `AmazonSSMRoleForInstancesQuickSetup`
  (create it if missing — Systems Manager offers a one-click button).
- Instance limit: `1`.
- Expiry: 30 days (the registration itself is permanent — only the activation
  code expires).
- Default instance name: `aberp-site`.

Save the **Activation Code** and **Activation ID** (shown once).

### 6. Run the bootstrap

```sh
sudo SSM_ACTIVATION_CODE=<code> \
     SSM_ACTIVATION_ID=<id> \
     AWS_REGION=eu-central-1 \
     bash bin/lightsail-bootstrap.sh
```

The script:

1. Updates the system + installs base packages.
2. Installs Node 20 LTS.
3. Creates the `aberp` system user and `/home/aberp/{releases,logs}`.
4. Initialises `/dev/xvdf` (mkfs.ext4 — **destructive on first run**, skipped
   afterwards if a filesystem signature exists), mounts it at
   `/mnt/aberp-data`, adds an fstab entry, and symlinks
   `/home/aberp/data → /mnt/aberp-data`.
5. Installs the SSM Agent (snap) and registers as hybrid instance using your
   activation code/id. Print out the resulting `mi-…` instance ID afterwards
   with `cat /var/lib/amazon/ssm/registration` or via the SSM Fleet Manager UI.
6. Installs AWS CLI v2.
7. Drops `lightsail-deploy.sh` into `/home/aberp/`.
8. Installs the systemd unit (`aberp-site.service`) and enables it.
9. Writes the `/etc/aberp-site.env` template.
10. Configures `ufw` to allow only SSH on the OS firewall (CloudFront origin
    traffic is handled separately — see CloudFront behaviours doc).
11. Installs a logrotate config for the Node process logs.

### 7. Fill in the env file

```sh
sudo openssl rand -hex 32 | sudo tee /tmp/admin-token  # take note, don't commit
sudo $EDITOR /etc/aberp-site.env
```

Set:

- `ABERP_SITE_ADMIN_TOKEN` — paste the token you just generated. Same value
  goes into ABERP's Quote Intake config when you wire the loop closed (S210).
- `CLOUDFRONT_SHARED_SECRET` — generate another `openssl rand -hex 32`. Save
  this value; you'll paste it into the CloudFront origin's "Add custom
  headers" panel (header name `X-CloudFront-Secret`).

### 8. First deploy

Trigger the GitHub Actions workflow manually (workflow_dispatch). The deploy
job will:

- Push `build-server-<sha>.tgz` to `s3://<bucket>/_deploy/`.
- `ssm send-command` runs `/home/aberp/lightsail-deploy.sh <sha>` on this box.
- The script pulls the tarball, extracts to `/home/aberp/releases/<sha>/`,
  runs `npm ci --omit=dev`, atomically symlinks `current → releases/<sha>`,
  restarts the systemd unit, and curls `http://127.0.0.1:3000/healthz` to
  verify (an always-open endpoint provided by `src/hooks.server.ts`; auto-
  rolls back if it doesn't return 200 within 20s).

Until the first deploy lands, `systemctl status aberp-site` will report
`/home/aberp/current` missing — that's expected.

## CloudFront → Lightsail origin

The Node server binds to `127.0.0.1:3000` by default (`HOST=127.0.0.1` in the
env file). For CloudFront to reach it, you have **two acceptable choices**:

| Option                                   | What                                                                                                       | Trade-off                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **A. nginx reverse proxy (recommended)** | Install nginx, listen on `:80`, `proxy_pass http://127.0.0.1:3000;`. CloudFront origin = `<static-ip>:80`. | One extra moving part. Lets you terminate connections, add response headers, set timeouts, hand off later to TLS without touching Node. |
| **B. Bind Node to `0.0.0.0:3000`**       | Set `HOST=0.0.0.0` in `/etc/aberp-site.env`. Open Lightsail console firewall to port 3000.                 | Simpler — one fewer service. Slightly larger attack surface; you rely entirely on the shared-secret header for origin auth.             |

The bootstrap script defaults to option B-ready (`HOST=127.0.0.1`); you can
either install nginx or change `HOST` later. Either way, the
`X-CloudFront-Secret` header check in `src/hooks.server.ts` is the
defence-in-depth that makes "open the box to CloudFront" acceptable.

## Lightsail console firewall

Networking → Firewall on the instance:

- Allow SSH (22) from your IP only.
- Allow HTTP (80) from anywhere if you're using nginx (option A).
- Allow custom TCP (3000) from anywhere if you bound Node directly (option B).

Lightsail does not let you allowlist CloudFront's IP prefix list directly; the
shared-secret header is what enforces origin trust.

## Rollback

The deploy script keeps the last 5 releases under `/home/aberp/releases/`. Manual
rollback:

```sh
ssh aberp@<static-ip>          # or sudo -u aberp
ls -dt /home/aberp/releases/*  # find the previous SHA
ln -sfn /home/aberp/releases/<prev-sha> /home/aberp/current.new
mv -Tf /home/aberp/current.new /home/aberp/current
sudo systemctl restart aberp-site
```

The deploy script also rolls back automatically when its post-deploy
`curl http://127.0.0.1:3000/` health-check fails (returns non-zero, GitHub
Actions step fails red).

## Re-running the bootstrap

Safe — every step except the first-run `mkfs` is idempotent. If you re-attach
a fresh disk, the mkfs step still runs (it skips only when an existing
filesystem signature is detected). To force-skip the disk step entirely, run
with `ABERP_DATA_DISK=/dev/null`.
