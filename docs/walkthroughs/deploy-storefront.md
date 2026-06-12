# Walkthrough — storefront persistent state dirs (systemd / Lightsail instance)

**Goal:** make the storefront's three persistent state dirs — email outbox,
material catalogue, and customer quotes — survive a redeploy, and prove it at
boot so a misconfiguration refuses to start instead of silently losing data.

**Why this exists:** S356 — `ABERP_SITE_QUOTE_DIR` defaulted to the
process-CWD-relative `./data/quotes`, which `pathResolve` anchored _inside_ the
immutable release dir. A customer submission landed there, the next deploy
swapped the release dir, and `GET /api/quotes/{id}/priced` then 404'd because
`metadata.json` was gone. CloudFront's `404 → /index.html` rule masked that 404
as a 200 `text/html` SPA shell, which ABERP's writeback classifier mislabelled
as a CDN routing fault. Same defect class as S311 (email outbox) and S343
(catalogue); same fix — an absolute canonical state dir under
`/home/aberp/data`, boot-checked.

**Applies to:** the Lightsail **instance** + systemd deployment
(`docs/aws/lightsail-bootstrap.md`, `docs/aws/aberp-site.service`). The legacy
container sketch in `docs/deploy.md` is superseded by this for the state-dir
envs.

---

## The three canonical state dirs

All three live under `/home/aberp/data`, which the systemd unit whitelists in
`ReadWritePaths=` (`docs/aws/aberp-site.service:31`). `ProtectSystem=strict`
makes everything else (including the release dir) read-only.

| Env var                       | Default (canonical)             | Boot check |
| ----------------------------- | ------------------------------- | ---------- |
| `ABERP_SITE_EMAIL_OUTBOX_DIR` | `/home/aberp/data/email-outbox` | `F15`      |
| `ABERP_SITE_CATALOGUE_DIR`    | `/home/aberp/data/catalogue`    | `F-CAT`    |
| `ABERP_SITE_QUOTE_DIR`        | `/home/aberp/data/quotes`       | `F-QUOTE`  |

Each resolver throws on a **relative** override; each boot check refuses startup
(503 on every non-`/healthz` request) if its dir is missing, relative, or
unwritable.

---

## Step 1 — [Lightsail SSH] Set the env vars in `/etc/aberp-site.env`

```sh
sudo $EDITOR /etc/aberp-site.env
```

Ensure these lines are present (the defaults match the canonical dirs, so these
are belt-and-suspenders, but set them explicitly so a future default change
can't silently move state):

```ini
ABERP_SITE_EMAIL_OUTBOX_DIR=/home/aberp/data/email-outbox
ABERP_SITE_CATALOGUE_DIR=/home/aberp/data/catalogue
ABERP_SITE_QUOTE_DIR=/home/aberp/data/quotes
```

> **Must be absolute.** A relative value (e.g. `./data/quotes`) makes the
> resolver throw at first use and `F-QUOTE` refuse startup — by design.

## Step 2 — [Lightsail SSH] Ensure the dirs exist and are owned by the service user

`lightsail-bootstrap.md` symlinks `/home/aberp/data → /mnt/aberp-data` (the
attached block-storage volume — durable across redeploys). Create the quote dir
if a fresh box doesn't have it yet:

```sh
sudo install -d -o aberp -g aberp /home/aberp/data/quotes
```

## Step 3 — [Lightsail SSH] Reload and restart

```sh
sudo systemctl daemon-reload
sudo systemctl restart aberp-site
```

## Step 4 — [Lightsail SSH] Verify the F-QUOTE boot probe passed

```sh
journalctl -u aberp-site --since '1 min ago' | grep -E 'F-QUOTE|F-CAT|F15'
```

**Expected:** no `F-QUOTE` (or `F-CAT` / `F15`) line at all — the boot checks
only log when they _fail_. A clean boot is silent here and the service is
`active (running)`:

```sh
systemctl is-active aberp-site   # → active
```

**Failure mode:** a line like
`F-QUOTE: [aberp-site] ABERP_SITE_QUOTE_DIR="…" is not usable: …` means the
service is refusing to serve (every request 503s). Fix the path/permissions per
the message and restart. The message names the canonical default and the
`ReadWritePaths` requirement.

## Step 5 — [Mac terminal] Smoke-test redeploy durability

After the next deploy, confirm an existing priced quote still resolves (this is
the exact S356 regression):

```sh
curl -sIo /dev/null -w '%{http_code} %{content_type}\n' \
  https://abenerp.com/api/quotes/<known-quote-id>/priced \
  -H 'Authorization: Bearer <admin-token>'
```

**Expected:** `200 application/json` (or `404 application/json` for a genuinely
unknown id — note the JSON content-type, not `text/html`). A `200 text/html`
body means CloudFront masked a 404; see
`docs/walkthroughs/cloudfront-error-page-fix.md`.
