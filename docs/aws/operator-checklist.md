# ABERP-site AWS provisioning checklist

Linear recipe to take this repo from "code committed" to "abenerp.com live on
AWS, deploys via `git push`." Follow each step in order. The checklist itself
is self-contained; each step links to the deeper doc.

## Pre-requisites

- [ ] AWS account with admin access, billing enabled.
- [ ] Route 53 hosted zone for `abenerp.com` (existing, per Phase 1).
- [ ] AWS CLI v2 installed locally; `aws sts get-caller-identity` works.
- [ ] You're on macOS / Linux with `git`, `openssl`, `ssh`.
- [ ] Existing Phase 1 S3 bucket name + CloudFront distribution ID handy (the
      Phase 2 work updates them in place rather than creating new resources).

---

## Step 1 — GitHub repo

- [ ] Create the repo on github.com: `Cservin69/ABERP-site` (private or
      public — your call; private is fine until launch).
- [ ] Push the local main branch:
      `sh
cd /Users/aben/Documents/Claude/Projects/ABERP-site
git remote add origin git@github.com:Cservin69/ABERP-site.git
git push -u origin main
`

---

## Step 2 — AWS OIDC provider (one-time per account)

- [ ] Follow `docs/aws/iam-deploy-role.md` Step 1.
      Console: IAM → Identity providers → Add → OpenID Connect:
      URL `https://token.actions.githubusercontent.com`,
      audience `sts.amazonaws.com`.

---

## Step 3 — Deploy role

- [ ] Follow `docs/aws/iam-deploy-role.md` Step 2. Substitute `ACCOUNT_ID`,
      `BUCKET_STATIC`, `DISTRIBUTION_ID`, `INSTANCE_ID`. `INSTANCE_ID` you
      don't have yet — leave it as a placeholder; come back and tighten
      after Step 6.
- [ ] The trust policy uses `StringEquals` on the `sub` claim with two values:
      `refs/heads/main` (covers the `build` job) and `environment:production`
      (covers the `deploy-static` / `deploy-dynamic` jobs). This is mandatory
      — a wildcard sub would let any PR branch assume the deploy role.
- [ ] Create the GitHub environment **now** (otherwise the deploy jobs will be
      stuck waiting on a non-existent environment):
      `Cservin69/ABERP-site` → Settings → Environments → New environment
      `production`. Under **Required reviewers** add `ervin@aben.ch`
      (Ervin Cservinszky). Optionally restrict deployment branches to
      `main` only. The `deploy.yml` workflow declares
      `environment: production` on the AWS-touching jobs; with required
      reviewers set, every deploy pauses for Ervin's explicit approval before
      AWS credentials are issued.
- [ ] Copy the role ARN.

---

## Step 4 — GitHub repo variables

- [ ] `Cservin69/ABERP-site` → Settings → Secrets and variables → Actions →
      **Variables** tab → set: - `AWS_DEPLOY_ROLE_ARN` = role ARN from Step 3 - `ABERP_SITE_BUCKET` = your S3 bucket name - `ABERP_SITE_CF_DIST` = your CloudFront distribution ID - `ABERP_SITE_LS_INSTANCE` = (placeholder for now — fill in after Step 6)

---

## Step 5 — Lightsail provisioning

Follow `docs/aws/lightsail-bootstrap.md` for the narrative.

- [ ] Lightsail console → Create instance:
      Region eu-central-1, Ubuntu 22.04 LTS, plan **Nano $3.50/mo**,
      name `aberp-site`.
- [ ] Networking → Static IPs → create + attach to the instance.
- [ ] Storage → Create disk: 20 GB, name `aberp-site-data`, attach to
      `aberp-site` (mounts as `/dev/nvme1n1` on current Nitro Lightsail, or
      `/dev/xvdf` on older Xen instances — the bootstrap auto-detects).
- [ ] SSH in: `ssh ubuntu@<static-ip>`.
- [ ] Clone the repo: `git clone https://github.com/Cservin69/ABERP-site.git`.

---

## Step 6 — SSM hybrid activation + bootstrap

- [ ] In the AWS Console: Systems Manager → Hybrid Activations → Create
      activation. Role `AmazonSSMRoleForInstancesQuickSetup`, limit 1, expiry
      30 days.
- [ ] Note the **Activation Code** and **Activation ID** (shown once).
- [ ] On the Lightsail box (still SSH'd in), inside the cloned repo:
      `sh
sudo SSM_ACTIVATION_CODE=<code> \
     SSM_ACTIVATION_ID=<id> \
     AWS_REGION=eu-central-1 \
     bash bin/lightsail-bootstrap.sh
`
- [ ] Find the `mi-…` instance ID:
      `sudo cat /var/lib/amazon/ssm/registration` — or in the AWS Console,
      Systems Manager → Fleet Manager → look for the instance you just
      registered. It looks like `mi-0123abc…`.
- [ ] Save the `mi-…` into the GitHub repo variable `ABERP_SITE_LS_INSTANCE`.
- [ ] Tighten the IAM deploy-role policy ARNs from Step 3 to reference the
      real instance ID (the SSM action ARNs).

---

## Step 7 — Operational secrets on the Lightsail box

- [ ] Generate the admin token: `sudo openssl rand -hex 32` — copy the output.
- [ ] Generate the CloudFront shared secret: `sudo openssl rand -hex 32`.
- [ ] Edit `/etc/aberp-site.env` (`sudo $EDITOR …`) and fill: - `ABERP_SITE_ADMIN_TOKEN=<admin token>` - `CLOUDFRONT_SHARED_SECRET=<cloudfront secret>` - `QUOTE_STATUS_SIGNING_KEY=<openssl rand -hex 32>` (required for the
      customer-facing /q/<id>?t=… status page; missing key returns 503 on
      every quote confirmation send) - `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/
      `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` + `ABERP_SITE_OPERATOR_EMAIL` if you
      want the transactional confirmation + alert emails to actually send;
      with `SMTP_HOST` blank the send path no-ops gracefully. Leave `HOST`,
      `PORT`, `PROTOCOL_HEADER`, `HOST_HEADER`, `ABERP_SITE_QUOTE_DIR`,
      `NODE_ENV`, `BODY_SIZE_LIMIT`, `ABERP_SITE_PUBLIC_URL`, and
      `ABERP_SITE_PUBLIC_BASE_URL` at their defaults unless you have a reason
      to change.
      The bootstrap script pins `BODY_SIZE_LIMIT=52428800` (50 MB) — without
      it, adapter-node silently 413s every CAD upload at 512 KB. The
      `aberp-site.service` unit also sets it via `Environment=` as a
      belt-and-suspenders default. After first start, run
      `sudo journalctl -u aberp-site | grep BODY_SIZE_LIMIT` — if you see a
      warning line, the cap is misconfigured.
- [ ] Save both secrets in your password manager. The admin token also goes
      into ABERP's Quote Intake config when you wire that up (S210); the
      CloudFront secret goes into the CloudFront origin config (Step 8).

---

## Step 8 — CloudFront behaviours

Follow `docs/aws/cloudfront-behaviors.md`. Highlights:

- [ ] Add a second origin pointing at the Lightsail static IP (port 80 if
      you'll install nginx, 3000 if you bind Node to 0.0.0.0). For the v1
      shortcut, bind Node to 0.0.0.0 and use port 3000.
- [ ] Set the Lightsail origin's **custom header**:
      name `X-CloudFront-Secret`, value = your `CLOUDFRONT_SHARED_SECRET`.
- [ ] Add path-pattern cache behaviours per the table in
      `cloudfront-behaviors.md`. The three dynamic patterns
      (`/quote*`, `/api/*`, `/admin*`) route to the Lightsail origin with
      `CachingDisabled` + `AllViewer` origin request policy.
- [ ] Update the viewer-request CloudFront Function so it only rewrites
      `/privacy` and `/imprint` (and not the dynamic paths).

If you bind Node directly to `0.0.0.0:3000`:

- [ ] Edit `/etc/aberp-site.env` on the Lightsail box: `HOST=0.0.0.0`.
- [ ] Lightsail console → Networking → Firewall: allow custom TCP `3000` from
      anywhere. The shared-secret check is what stops random scanners.

---

## Step 9 — First deploy

- [ ] GitHub → Actions → Deploy to AWS → Run workflow → branch `main`.
- [ ] Watch the run. The three jobs run in order: `build` → `deploy-static`,
      `deploy-dynamic`. If `deploy-dynamic` hangs at "Dispatch deploy on
      Lightsail via SSM", check that the `mi-…` instance is online
      (Systems Manager → Fleet Manager).
- [ ] On success:
      `sh
      curl -fsS https://abenerp.com/ # → 200, prerendered home
      curl -fsS https://abenerp.com/quote # → 200, SSR form HTML
      curl -fsS https://abenerp.com/api/quotes
  # → 401 without bearer (good)
  curl -fsS -H "Authorization: Bearer <admin-token>" \
   https://abenerp.com/api/quotes
  # → 200 [] (good)
  `

---

## Step 10 — Enable push-to-deploy

The `production` GitHub environment with required reviewer is now created in
Step 3 and wired into `deploy.yml`. Every push to `main` triggers the workflow,
the `build` job runs unattended, then `deploy-static` and `deploy-dynamic`
pause at the environment-protection gate until Ervin approves them.

- [ ] Verify the gate works: push a trivial change to `main`, watch GitHub
      Actions, confirm the deploy jobs sit in the "Waiting for approval"
      state. Approve once you're ready; AWS credentials are minted only after
      the approval click.
- [ ] If at any point you want to dispatch a deploy without the approval
      pause (e.g. you're at the keyboard and just want it to ship), the
      required-reviewer setting is reachable in repo Settings → Environments
      → production. **Do not** widen the IAM trust-policy `sub` to a wildcard
      to bypass the gate; the wildcard form is the vulnerability this step
      closes.

---

## Step 11 — ABERP integration (post-launch, separate session)

- [ ] In the ABERP Tenant Settings → Quote Intake panel: set the base URL to
      `https://abenerp.com` and the admin token to the value from Step 7.
- [ ] Verify the polling loop end-to-end: submit a quote on
      `/quote`, see it land in ABERP within a poll cycle.

---

## Cost estimate (steady-state, EU-only traffic)

| Item                                                      | Monthly       |
| --------------------------------------------------------- | ------------- |
| Lightsail Nano instance                                   | $3.50         |
| Lightsail static IP (attached)                            | included      |
| Lightsail block storage 20 GB                             | ~$2.00        |
| S3 storage (current site < 50 MB)                         | < $0.01       |
| S3 staging prefix (`_deploy/`, 1 tarball/deploy × few MB) | < $0.10       |
| CloudFront requests + transfer (low volume)               | < $1          |
| Route 53 hosted zone                                      | $0.50         |
| ACM cert                                                  | free          |
| Total                                                     | **~$7/month** |

Hot bills appear if/when traffic ramps — CloudFront requests and data transfer
out are the levers. Re-evaluate the price class and add a budget alarm in
Cost Explorer once steady-state load is established.

---

## What this checklist intentionally defers

- Multi-region failover (not needed at v1).
- WAF rules in front of CloudFront (revisit when CAD-upload abuse appears).
- CI for staging environment.
- Monitoring/alerting beyond CloudWatch defaults (add when paged once).
- Automated DB backup beyond `data/quotes/` rsync to a private S3 bucket
  (see `docs/deploy.md` "Backup" section).
