# Option D pilot walkthrough

**The morning-of runbook for Ervin's first real customer-quote flow through prod.**

## What this covers

This is the last step before the auto-quote email pipeline runs live: it walks the
whole path end to end — pre-flight on the Mac, confirming the storefront deploy on
Lightsail, reconciling the shared bearer token, one real smoke submission, the
failure modes you might hit, and how to roll back without taking the storefront down.
Every command below has been verified against current `main` of both repos; where a
command reads or writes a service-owned path you'll see the exact `sudo` form that
actually works when you're logged in as `ubuntu`.

Architecture is **ADR-0009 — storefront-as-queue, ABERP polls outbound, no tunnel,
no third party** (`docs/adr/0009-storefront-as-queue-no-tunnel.md`):

- The **storefront** (Lightsail, public at `https://abenerp.com`) writes every
  outbound email to a queue directory on its own disk and exposes a bearer-gated
  polling API.
- **ABERP** (Ervin's MacBook, loopback-only) makes **outbound HTTPS only**. It polls
  the storefront's email queue every ~5 seconds, claims each entry, sends it via
  ABERP's SMTP, and writes the result back.
- There is **no inbound path to the Mac**. No `cloudflared`, no Tailscale, no
  WireGuard. If the Mac is asleep, queue entries pile up on Lightsail and drain when
  it wakes.

```
  Customer browser
       │  (1) submit quote, (4) click accept
       ▼
  https://abenerp.com   ── Lightsail (Ubuntu) behind CloudFront ──
       │  writes  /home/aberp/data/email-outbox/queued/<id>.json
       │  serves  GET /api/internal/email-queue   (bearer-gated)
       ▲
       │  outbound HTTPS only — every ~5s
  Ervin's MacBook (ABERP, 127.0.0.1:<port>)
       └── poll queue → claim → SMTP send → POST .../sent | .../failed
```

## What you need before starting

- **A Mac terminal** with the Lightsail SSH key already in `~/.ssh/` (you log in as
  the `ubuntu` user — see the SSH note below).
- **GitHub web access** with write permission on the `ABERP-site` repo, plus rights
  to approve the `production` environment (the deploy waits for a human click).
- The **`gh` CLI** authenticated (`gh auth status` should show you logged in). Used to
  check and re-trigger the deploy without leaving the terminal.
- **ABERP keychain entries** set up on the Mac (Phase 0 verifies this).
- **The Lightsail static IP.** Everywhere below shows `<lightsail-static-ip>` —
  substitute the real IP. It's in the Lightsail console, or in your `~/.ssh/config`
  if you have a host alias.

> **SSH user — read this once.** You log into Lightsail as **`ubuntu`**, the default
> Lightsail account. The storefront runs as a _separate, login-less_ service user
> named **`aberp`** that owns everything under `/home/aberp/`. `ubuntu` cannot read
> those paths directly — every command in Phase 1+ that touches `/home/aberp/*` is
> therefore prefixed with `sudo`. This is expected; you do not need an `aberp` login
> (the box has no SSH key for `aberp` — GitHub deploys reach it over SSM, not SSH).

> **Versions this was written against:** ABERP `PROD_v2.27.11`, storefront `main` at
> `9b5611d` (S313). Env-var names, audit-event names, paths, and log strings below are
> pinned in code (verified against source), not in this doc — later versions should
> still match.

> **Tenant placeholder:** every `prod` below is the ABERP tenant id — the default that
> `run/upgrade_prod.sh` and `run/run_prod.sh` hard-code (`tenant="prod"`). If your
> tenant directory under `~/.aberp/` is named something else, substitute it everywhere.

---

## Phase 0 — Pre-flight on the Mac (ABERP side)

Goal: confirm ABERP is on `PROD_v2.27.11`, its keychain secrets are present, and it
has booted and written its runtime descriptor. All of Phase 0 is **Mac terminal**.

### 0.1 — Upgrade ABERP to PROD_v2.27.11 and launch it

First make sure the prod ABERP process is **not** running — the upgrade script
hard-refuses to swap a running binary (it `pgrep`s for `aberp-ui` / `aberp` and dies
if either is alive). If you have a `run_prod.sh` terminal open, go to it and press
`Ctrl-C`.

**Command:**

```bash
cd ~/Documents/Claude/Projects/ABERP
./run/upgrade_prod.sh PROD_v2.27.11
```

**WHY:** This validates the version string, snapshots the prod DB, does a clean
`git fetch` + checkout of the `PROD_v2.27.11` branch, verifies the tree is clean, then
`exec`s `run/run_prod.sh` — so **this same terminal becomes the live ABERP server**.
Everything downstream (the poll daemon, the keychain reads) depends on this boot.

**Expected output (tail):**

```
[ ok ] no aberp-ui / aberp process running — safe to swap
...
[ ok ] verified: on PROD_v2.27.11, clean tree, HEAD=9b5611d0a1b2 matches origin
...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  UPGRADE STATE READY — launching run_prod.sh
  FRISSÍTÉS KÉSZ — run_prod.sh indítása
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
...
boot step: reading session token from OS keychain (may prompt for keychain access)
...
email-outbox poll daemon spawned (S307 / PR-276)
```

The line **`email-outbox poll daemon spawned (S307 / PR-276)`** is the one that matters
— it means the polling daemon is alive. Leave this terminal running for the rest of the
pilot.

**If it fails:**

- `the prod app is still running … Stop it FIRST` → an old ABERP is alive; `Ctrl-C` its
  terminal (or `pkill -f run_prod.sh`) and re-run.
- You see `email-outbox poll daemon disabled by env (S307 / PR-276)` instead of
  `spawned` → a kill switch from a prior rollback is still set; go to
  [Phase 6](#phase-6--rollback-toggle) to unset it, then relaunch.

> **macOS keychain prompts:** boot reads several keychain entries in a burst. If macOS
> pops "ABERP wants to use your keychain", click **Always Allow** so later poll cycles
> don't re-prompt.

### 0.2 — Verify the keychain entries are present

**Command:**

```bash
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w >/dev/null && echo "OK: quote_intake bearer"
security find-generic-password -s "aberp.smtp.prod" -w >/dev/null 2>&1 && echo "OK: smtp password"
security find-generic-password -s "aberp.nav.prod" -w >/dev/null 2>&1 && echo "OK: nav credentials"
```

**WHY:** The pilot needs three secrets. The **first** is load-bearing for the email
path — it is the bearer token ABERP presents to the storefront on every
poll/claim/sent/failed call (service `aberp.quote_intake.prod`, account
`quote_intake_token`, verified in `apps/aberp/src/quote_intake_credentials.rs`). The
other two (SMTP send, NAV catalogue) must exist for the wider flow but aren't the email
bearer.

**Expected output:**

```
OK: quote_intake bearer
OK: smtp password
OK: nav credentials
```

**If it fails:** a missing `OK:` line means that entry is absent. The **quote_intake**
one is mandatory — set it via the ABERP SPA (Settings → Quote Intake) or directly with
`security add-generic-password` (see [Phase 2.3](#23--make-them-match)). A missing
`smtp`/`nav` line blocks send/catalogue but not the queue mechanics — fix it the same
way before going live.

> **Why this exact key?** The email-outbox daemon has **no** dedicated email token. It
> reuses the shared _storefront credential_ — the same base-URL + bearer the
> quote-intake and catalogue daemons use (`apps/aberp/src/storefront_credential.rs`).
> That credential's bearer is read from the keychain entry above
> (`quote_intake_credentials.rs`: service `aberp.quote_intake.<tenant>`, account
> `quote_intake_token`). One token, one keychain entry —
> [Phase 2](#phase-2--bearer-token-reconciliation) reconciles it against the storefront.

To print the actual value (you'll need it in Phase 2):

```bash
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w
```

### 0.3 — Verify the runtime descriptor exists

**Command:**

```bash
cat ~/.aberp/prod/runtime.json
```

**WHY:** ABERP writes `~/.aberp/<tenant>/runtime.json` on every successful boot and
deletes it on graceful shutdown (`apps/aberp/src/runtime_discovery.rs`). Its presence
confirms the server you launched in 0.1 actually finished booting this session, not a
stale leftover.

**Expected output (values will differ):**

```json
{
	"base_url": "https://127.0.0.1:18443",
	"relay_token_keychain_service": "aberp.email_relay.prod.email_relay_token",
	"started_at": "2026-06-09T07:30:00Z",
	"tenant": "prod",
	"tls_fingerprint": "0a1b2c3d...ff"
}
```

Confirm `started_at` is from **this** boot (within the last few minutes).

**If it fails:** `No such file or directory` → ABERP did not finish booting. Go back to
the 0.1 terminal and read upward for a fatal line (keychain denial, port in use, DB
snapshot failure).

> `relay_token_keychain_service` points at the **deprecated** push-relay token
> (ADR-0007, superseded). It is _not_ the bearer this pilot uses — ignore it. The pilot
> bearer is the `quote_intake_token` from 0.2.

---

## Phase 1 — Confirm the storefront deploy on Lightsail

Goal: get current `main` live on Lightsail and confirm the F15 boot-check passes (the
email-outbox directory is writable). This phase is **GitHub web + `gh` CLI + Lightsail
SSH**.

> **How storefront deploys actually work — read this, it is NOT a `git pull`.** The
> Lightsail box has **no git checkout**. Deploys are artifact-based: pushing to `main`
> triggers `.github/workflows/deploy.yml` ("Deploy to AWS"), which builds the server
> bundle in CI, uploads it to S3, and runs `/home/aberp/lightsail-deploy.sh <sha>` on
> the box via **SSM Run Command** (no SSH). That script unpacks the release into
> `/home/aberp/releases/<sha>/`, swaps the `/home/aberp/current` symlink, **and restarts
> the systemd service itself**. So you never SSH in to pull — you confirm CI is green,
> approve the `production` environment, and then SSH in only to _verify_.

### 1.1 — Confirm CI is green for the current `main` HEAD

**Command:**

```bash
gh run list --workflow "Deploy to AWS" --branch main --limit 5
```

**WHY:** A push to `main` auto-starts the deploy, but the `build` job must finish green
before the deploy jobs even appear for approval. This shows the latest runs and their
status without opening a browser.

**Expected output:**

```
STATUS  TITLE                                   WORKFLOW       BRANCH  EVENT  ID          ...
✓       S313 / PR-14: backstop deploy CI ...    Deploy to AWS  main    push   17231234567 ...
*       S313 / PR-14: backstop deploy CI ...    Deploy to AWS  main    push   17231234560 ...
```

`✓` = completed green. `*` (or `in_progress`) = still running; wait for it. `X` = failed.

**If it fails:**

- Top run shows `X` / `failure` → storefront CI has been **flaky** (a vitest hang,
  root-caused but not 100% cured). Don't debug it — just re-trigger:
  ```bash
  gh workflow run "Deploy to AWS" --ref main
  ```
  Wait ~1 min, re-run the `gh run list` above, and proceed once a run goes green.
- No run listed for the latest commit at all → trigger one with the same
  `gh workflow run` command.

### 1.2 — Approve the `production` environment (the only manual gate)

After the `build` job goes green, **two more jobs — `deploy-static` and
`deploy-dynamic` — appear with `Waiting for review`.** Both are pinned to the
`production` GitHub environment (verified in `deploy.yml`), and AWS credentials are only
minted **after** you approve. Nothing reaches Lightsail until you click.

**WHERE: GitHub web.** Steps:

1. Open the repo → **Actions** tab → click the **Deploy to AWS** run for your SHA.
2. Scroll to the **`deploy-static`** and **`deploy-dynamic`** jobs. Each shows a yellow
   **`Review deployments`** button.
3. Click **Review deployments**, tick the **`production`** checkbox, click **Approve and
   deploy**. Do this for **both** jobs.

**WHY:** This is the human-in-the-loop guard ADR-0009 keeps so a stray push can't
silently redeploy prod. The approval is what unlocks the S3 upload + SSM dispatch.

**Expected:** within a minute both jobs flip to running, then green. The `deploy-dynamic`
job's log ends with a health-check loop hitting `http://127.0.0.1:3000/healthz` on the
box and printing a success line.

**If it fails:**

- No `Review deployments` button → the `build` job hasn't finished green yet; wait.
- `deploy-dynamic` is **skipped** (grey) → the `ABERP_SITE_LS_INSTANCE` repo variable is
  empty, so the dynamic (Node-server) deploy is gated off. The Node server will **not**
  update. Set that variable in repo Settings → Variables, then re-run the workflow.
- `deploy-dynamic` goes red on the health-check step → the new release booted but
  503s; jump to [1.4](#14--verify-the-f15-boot-check-passed) — it's almost always a
  boot-check.

### 1.3 — SSH in and verify the live release

**Command:**

```bash
ssh ubuntu@<lightsail-static-ip>
```

then, on the box:

```bash
sudo systemctl status aberp-site --no-pager
readlink -f /home/aberp/current
```

**WHY:** Confirms the service is `active (running)` and which release the `current`
symlink now points at. The deploy script names each release directory by the **full
commit SHA**, so the resolved path tells you exactly what's live.

**Expected output:**

```
● aberp-site.service - ABERP-site SvelteKit Node server
     Loaded: loaded (/etc/systemd/system/aberp-site.service; enabled; ...)
     Active: active (running) since ...
...
/home/aberp/releases/9b5611d.../          <- release dir named by deployed commit SHA
```

The `releases/<sha>` directory should start with the SHA of the commit you just
deployed. If it shows an older SHA, the deploy in 1.2 didn't land — re-check the Actions
run.

**If it fails:**

- `Active: failed` / `inactive` → the unit died on boot; `sudo tail -40
/home/aberp/logs/aberp-site.err` for the reason, then [Phase 5.4](#54--storefront-systemd-service-dead).
- `readlink` prints nothing / `No such file` → `current` symlink missing; the deploy
  never completed — re-run the workflow.

Then confirm the health probe:

**Command:**

```bash
curl -fsS http://127.0.0.1:3000/healthz && echo
```

**WHY:** `/healthz` is the one route exempt from both the CloudFront-secret check and the
boot-check 503, so it answers `ok` even when real requests are blocked. A bare `ok`
proves the Node process is listening on `:3000`.

**Expected output:**

```
ok
```

**If it fails:** connection refused → the Node process isn't up (see status above). If
`/healthz` returns `ok` **but** real requests 503, the boot-checks failed — go to 1.4.

### 1.4 — Verify the F15 boot-check passed

S311's F15 boot-check refuses to serve (**503 on every non-`/healthz` request**) if the
email-outbox directory is missing, not absolute, or not writable by the `aberp` user.
The canonical path is **`/home/aberp/data/email-outbox`** — the shipped default
(`src/lib/server/email-outbox.ts`), no env needed. (`/home/aberp/data` is itself a
symlink onto the `/mnt/aberp-data` volume, granted in the unit's `ReadWritePaths=`.)

**Command:**

```bash
sudo ls -ld /home/aberp/data/email-outbox /home/aberp/data/email-outbox/{queued,claimed,sent,failed}
```

**WHY:** Confirms the four state directories exist and are owned by `aberp`. (You SSH'd
in as `ubuntu`, which can't traverse into `/home/aberp` — hence `sudo`. Running it
without `sudo` is exactly the `Permission denied` you'd otherwise hit.)

**Expected output:**

```
drwxr-xr-x 6 aberp aberp 4096 ... /home/aberp/data/email-outbox
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/queued
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/claimed
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/sent
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/failed
```

The dirs are created automatically on first boot/enqueue, so an empty tree is fine —
owner `aberp aberp` is what matters.

**If it fails:** `No such file or directory` → boot never created them, which means the
boot-check itself is failing (the path is overridden somewhere); check the err log
below. `Permission denied` → you dropped the `sudo`.

**Command (prove it's writable as the service user):**

```bash
sudo -u aberp touch /home/aberp/data/email-outbox/.pilot-write-test && \
sudo -u aberp rm /home/aberp/data/email-outbox/.pilot-write-test && \
echo "OK: outbox writable by aberp"
```

**WHY:** F15 tests writability by writing a sentinel as the service user. We do the same
— `sudo -u aberp` (not bare `sudo`) so the test reflects the _actual_ `aberp` process
and never leaves a root-owned file the service can't manage.

**Expected output:**

```
OK: outbox writable by aberp
```

**If it fails:** `Permission denied` / `Read-only file system` → the unit's
`ReadWritePaths=` doesn't cover the path, or the mount is wrong. The shipped unit
whitelists `/home/aberp/data`, so a stock box passes; an override is the usual cause.

**Command (confirm no boot-check logged a problem):**

```bash
sudo grep -E '\[boot-check (F15|F8|F19)\]' /home/aberp/logs/aberp-site.err | tail -5
```

**WHY:** When a boot-check fails it logs `[boot-check F15] <message>` (and similarly F8 /
F19) to the err log before serving 503s. Empty output = clean boot.

**Expected output:** _(empty — no boot-check problems)_

**If it fails (any line printed):**

- `[boot-check F15]` → outbox dir missing/non-absolute/not-writable. The message names
  the exact fix.
- `[boot-check F8]` → `ABERP_SITE_OPERATOR_EMAIL` is unset in `/etc/aberp-site.env`. Set
  it and `sudo systemctl restart aberp-site`. (This inbox is CC'd on every customer
  mail; without it, sends are silently skipped.)
- `[boot-check F19]` → `BODY_SIZE_LIMIT` isn't the expected 50 MB (`52428800`). The unit
  defaults it; an override in `/etc/aberp-site.env` is the cause.

---

## Phase 2 — Bearer-token reconciliation

Goal: the token ABERP presents **must byte-for-byte equal** the token the storefront
expects. If they differ, every poll 401s and **no emails send** — visibly now, via the
audit row you'll read in [Phase 5.3](#53--401-unauthorized-bearer-mismatch).

> **One shared secret — not an email-specific one.** ADR-0009 §Auth deliberately reuses
> the existing storefront-admin token. The same token also gates the priced-writeback
> and catalogue endpoints, so **if quotes already flow today, the token is already
> correct and you can confirm-and-skip.** The reconciliation is:
>
> | Side                       | Where the token lives | Name                                                            |
> | -------------------------- | --------------------- | --------------------------------------------------------------- |
> | **Mac (ABERP)**            | OS keychain           | service `aberp.quote_intake.prod`, account `quote_intake_token` |
> | **Storefront (Lightsail)** | `/etc/aberp-site.env` | env var `ABERP_SITE_ADMIN_TOKEN`                                |

### 2.1 — Read the token ABERP will present (Mac)

**Command:** _(Mac terminal)_

```bash
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w
```

**WHY:** This is the literal bearer the daemon sends as `Authorization: Bearer <…>`.
Call it `TOKEN_ABERP`.

**Expected output:** one line — the token string (no `OK:`, just the value).

**If it fails:** `SecKeychainSearchCopyNext: The specified item could not be found` →
the entry is absent; create it in 2.3.

### 2.2 — Read the token the storefront expects (Lightsail)

**Command:** _(Lightsail SSH, as `ubuntu`)_

```bash
sudo grep '^ABERP_SITE_ADMIN_TOKEN=' /etc/aberp-site.env
```

**WHY:** `/etc/aberp-site.env` is root-readable only; `sudo` is required. The value after
`=` is what the storefront compares every bearer against (`src/lib/server/auth.ts`). Call
it `TOKEN_STOREFRONT`.

**Expected output:**

```
ABERP_SITE_ADMIN_TOKEN=<some-long-token>
```

**If it fails:** empty output → the var isn't set; the storefront would 503 (not 401) on
`/api/internal/*`. Set it via the "brand-new token" path below.

### 2.3 — Make them match

Compare `TOKEN_ABERP` and `TOKEN_STOREFRONT`. **If they're identical, you're done —
skip to Phase 3.**

If they differ (or either is missing), take the **storefront's** value as source of
truth and write it into the Mac keychain. Cleanest path is via the ABERP SPA, which
writes the keychain entry **and** hot-reloads the daemon with no restart:

**WHERE: ABERP SPA → Settings → Quote Intake.**

1. Set **Base URL** to `https://abenerp.com` (no trailing slash needed).
2. Paste `TOKEN_STOREFRONT` into the **Bearer token** field.
3. **Save.** The next poll cycle (≤ ~5 s) picks it up — no ABERP restart.

**WHY the SPA path:** the daemon re-reads the credential snapshot at the top of every
cycle (`storefront_credential.snapshot()`), so a SPA save takes effect within one tick.

If you can't reach the SPA, set the keychain entry directly:

**Command:** _(Mac terminal)_

```bash
security add-generic-password -U -s "aberp.quote_intake.prod" -a "quote_intake_token" -w '<TOKEN_STOREFRONT>'
```

**WHY:** `-U` updates the entry in place. The daemon reads it on the next cycle, so no
restart is strictly needed — but if in doubt, `Ctrl-C` the ABERP terminal and re-run
`./run/run_prod.sh`.

**Expected output:** _(none — silent success)_

**If it fails:** a keychain-locked prompt → unlock and click **Always Allow**.

> **If you must generate a brand-new token** (first-ever setup): make a strong one on
> the Mac with `openssl rand -hex 32`, then write it to **both** sides — set
> `ABERP_SITE_ADMIN_TOKEN=` in `/etc/aberp-site.env` on Lightsail (`sudo` edit, then
> `sudo systemctl restart aberp-site`) and the keychain entry on the Mac (SPA or the
> `security add-generic-password` above).

---

## Phase 3 — End-to-end smoke (one real submission)

Goal: push one real STEP file through `abenerp.com/quote` and watch it travel
**queued → claimed → sent**, with matching audit rows in ABERP.

Keep three windows open: a **browser**, an **SSH session to Lightsail** (as `ubuntu`),
and the **ABERP SPA**.

### 3.1 — Submit a quote

**WHERE: Mac browser.**

1. Open `https://abenerp.com/quote`.
2. Upload a STEP file (`.step` / `.stp`). Fill the contact email with **your own
   inbox** so you can confirm receipt.
3. Submit.

**WHY:** This is the real ingress. The acknowledgment email is _enqueued_ to the
storefront's disk, not sent inline — which is exactly the path we're validating.

**Expected:** the page shows an immediate **"received"** acknowledgment.

**If it fails:**

- A **403** page → the CloudFront-secret check rejected you (you hit the raw IP, or the
  shared header is misconfigured). Use the public `https://abenerp.com`, not the IP.
- A **503** → boot-check failure; go back to [1.4](#14--verify-the-f15-boot-check-passed).
- A **413** → upload exceeded `BODY_SIZE_LIMIT` (50 MB); use a smaller STEP.

### 3.2 — Confirm the email landed in the queue

**Command:** _(Lightsail SSH)_

```bash
sudo ls -t /home/aberp/data/email-outbox/queued/
```

**WHY:** Proves the storefront persisted the acknowledgment to disk. Each entry is a
single `<ULID>.json` (26-char Crockford-base32 id).

**Expected output:** one new file, e.g.

```
01J9Z3K8QF7M2N4P6R8T0V2X4Z.json
```

Inspect it:

```bash
sudo cat /home/aberp/data/email-outbox/queued/$(sudo ls -t /home/aberp/data/email-outbox/queued/ | head -1)
```

**Expected output (abridged — real entries also carry `cc`, `body_text`, optional
`body_html`/`attachments`):**

```json
{
	"id": "01J9Z3K8QF7M2N4P6R8T0V2X4Z",
	"queued_at": "2026-06-09T07:35:01.123Z",
	"to": ["you@example.com"],
	"subject": "...",
	"submitter": "submission_received",
	"state": "queued",
	"attempt_n": 0,
	"last_error": null,
	"sent_at": null,
	"audit_id": null,
	"claimed_at": null
}
```

**If it fails:** `queued/` is empty → the submission never persisted; re-check 3.1's
acknowledgment and the err log. (`Permission denied` → you dropped `sudo`.)

### 3.3 — Watch ABERP poll, claim, and send

**Command:** _(Lightsail SSH)_

```bash
sudo ls /home/aberp/data/email-outbox/queued/ /home/aberp/data/email-outbox/sent/
```

**WHY:** The daemon polls every **5 s** by default (`ABERP_EMAIL_OUTBOX_POLL_SECS`,
clamp `[1, 3600]`). Within ~5–10 s the entry moves out of `queued/` into `sent/`. Run
this a couple of times.

**Expected output:** the id now sits under `sent/`, gone from `queued/`. If you catch it
mid-flight you may briefly see it in `claimed/` — the optimistic lock held during the
SMTP send; it shouldn't linger more than a few seconds.

Inspect the sent record — it now carries `sent_at` and an `audit_id`:

```bash
sudo cat /home/aberp/data/email-outbox/sent/$(sudo ls -t /home/aberp/data/email-outbox/sent/ | head -1)
```

**Expected output (abridged):**

```json
{
	"id": "01J9Z3K8QF7M2N4P6R8T0V2X4Z",
	"state": "sent",
	"attempt_n": 1,
	"sent_at": "2026-06-09T07:35:06.456Z",
	"audit_id": "01J9Z3K9...",
	"claimed_at": "2026-06-09T07:35:06.001Z",
	"last_error": null
}
```

**If it fails:**

- Entry **stays in `queued/`**, never reaches `claimed/` → almost always a 401 bearer
  mismatch; go to [Phase 5.3](#53--401-unauthorized-bearer-mismatch).
- Entry **stuck in `claimed/`** > a minute → a wedged claim; the storefront
  auto-recovers it — see [Phase 5.1](#51--wedged-claim-recovery-no-operator-action).
- Entry in `failed/` → SMTP send failed; `sudo cat` it and read `last_error.detail`.

### 3.4 — Confirm the submission shows in ABERP

**WHERE: ABERP SPA → Auto-árazás.**

The new submission should appear in the intake list.

**WHY:** A separate daemon — the **quote-pricing-pipeline**, which polls
`GET /api/quotes?status=received` on its **own ~60 s cadence** — is what pulls received
submissions into ABERP. (This is independent of the 5 s email poll, so it can lag the
queued email by up to a minute. That lag is expected.)

**If it fails:** nothing appears after ~90 s → check the ABERP terminal for pipeline
poll errors; a 401 here too points back to the same bearer mismatch as Phase 2.

### 3.5 — Confirm the audit trail

**WHERE: ABERP SPA → Audit log** (filter for `quote.email_outbox_*`).

For a healthy flow you'll see:

- `quote.email_outbox_fetched` — emitted **every** poll cycle (carries `fetched_count`;
  fires even on empty cycles).
- `quote.email_outbox_claimed` — the daemon claimed your entry.
- `quote.email_outbox_sent` — SMTP send + writeback succeeded.

**WHY:** These are the ground truth that the daemon is doing real work, not just that
files moved. (`quote.email_outbox_failed` only appears on a send failure — you should
**not** see it here.)

**If it fails:** you see `fetched` rows with `error_class: auth_failed` once per cycle →
bearer mismatch, [Phase 5.3](#53--401-unauthorized-bearer-mismatch). You see **no**
`fetched` rows at all → the daemon isn't running; re-check the 0.1 spawn line.

### 3.6 — Confirm the email arrived

**WHERE: Mac browser (your inbox).**

The `submission_received` acknowledgment should be in your inbox.

**WHY:** Closes the loop end to end — disk → poll → SMTP → real delivery.

**If it fails:** file moved to `sent/` but no email → check ABERP's SMTP creds
(`aberp.smtp.prod`) and your spam folder. The `sent/` state means ABERP's SMTP server
_accepted_ the message; delivery beyond that is your mail provider's domain.

> **The full pilot also expects** a `priced_ready` email (after you run pricing in the
> SPA and it writes the priced PDF back) and an `accept_confirmation` email (after you
> click accept on the customer status page). Each is just another entry flowing through
> the same queued → claimed → sent path with a different `submitter` — repeat 3.2–3.6
> for each.

---

## Phase 4 — What "healthy steady state" looks like

Once the pilot is running, this is the baseline so you can tell normal from wrong at a
glance:

- **`queued/`** is empty or near-empty most of the time (entries drain within ~5 s).
- **`claimed/`** is empty between sends. An entry sitting in `claimed/` for more than a
  minute is the wedge in [Phase 5.1](#51--wedged-claim-recovery-no-operator-action).
- **`sent/`** and **`failed/`** accumulate — they are the durable audit trail. There is
  **no auto-cleanup in v1** (ADR-0009 open question 2); a few KB per quote is fine for
  the pilot.
- The SPA's email-outbox status panel shows `spawned: true`, a recent `last_poll_ts`,
  and `entries_in_progress: 0` between sends.
- The ABERP audit log shows a steady drip of `quote.email_outbox_fetched` rows (~every
  5 s) with `error_class` **absent** — that's the heartbeat.

Quick one-liner to eyeball the queue depth (Lightsail SSH):

```bash
for d in queued claimed sent failed; do printf "%-8s %s\n" "$d" "$(sudo ls /home/aberp/data/email-outbox/$d | wc -l)"; done
```

Healthy reads as `queued 0`, `claimed 0`, and non-zero `sent`.

---

## Phase 5 — Failure-mode walkthroughs

### 5.1 — Wedged claim recovery (no operator action)

**Symptom:** an entry sits in `/home/aberp/data/email-outbox/claimed/` and doesn't move
to `sent/` or `failed/`.

**Cause:** ABERP claimed the entry (atomic `queued → claimed` rename), then crashed or
lost the writeback _after_ the SMTP send but _before_ posting `.../sent`. The daemon's
normal cycle only scans `queued/`, so without recovery the entry would strand forever.

**What happens automatically (S311 / F1 — `recoverStaleClaimed` in
`src/lib/server/email-outbox.ts`):** on every `GET /api/internal/email-queue` call, the
storefront first sweeps `claimed/` and atomically renames any entry whose `claimed_at`
is older than the stale-claim TTL back to `queued/`. The daemon re-claims and re-sends
it on a later cycle.

**Operator action: none.** Wait **one TTL window** — default **600 s (10 min)**
(`ABERP_SITE_EMAIL_OUTBOX_STALE_CLAIM_TTL_SECS`, clamp `[1, 86400]`). After that the
entry reappears in `queued/` and drains normally.

> 🟥 **Do not hand-fix a wedged claim.** If ABERP _did_ send but only the writeback
> failed, recovery re-sends — the customer gets a duplicate. This is accepted for the
> pilot's single-digit-emails-per-day volume (ADR-0009 Consequences §3). Let the sweep
> handle it.

To shorten the TTL for a test (Lightsail SSH):

```bash
echo 'ABERP_SITE_EMAIL_OUTBOX_STALE_CLAIM_TTL_SECS=120' | sudo tee -a /etc/aberp-site.env
sudo systemctl restart aberp-site
```

### 5.2 — Mac asleep mid-submission

**Symptom:** you submit a quote with the MacBook lid closed; nothing sends.

**This is expected and self-healing.** The submission persists into `queued/` on
Lightsail. ABERP isn't polling while asleep, so the entry waits. When the Mac wakes, the
daemon's next cycle (≤ ~5 s after the network returns) fetches and sends it.

**Operator action: none.** Open the lid; watch `queued/` drain.

### 5.3 — 401 Unauthorized (bearer mismatch)

**Symptom:** emails never send, `queued/` keeps growing, nothing reaches `claimed/`.

**Cause:** the token ABERP presents no longer matches `ABERP_SITE_ADMIN_TOKEN` on the
storefront — almost always one side rotated without the other.

**How to confirm which side is wrong (S311 / F18):** errored poll cycles now emit an
audit row, so the failure is visible, not silent. In the ABERP SPA audit log, look for
`quote.email_outbox_fetched` rows with **`error_class: auth_failed`**, once per poll
cycle. (Verified: the daemon classifies any `HTTP 401` as `auth_failed` —
`email_outbox_poll_daemon.rs`.) That recurring row — rather than silence — is the
signal the bearer is mismatched, not that the daemon is dead or the queue is empty.

**Fix:** re-run [Phase 2](#phase-2--bearer-token-reconciliation) — read both sides, make
them match. Fastest is the SPA path (2.3), which hot-reloads with no restart.

### 5.4 — Storefront systemd service dead

**Symptom:** `https://abenerp.com/quote` is down, or ABERP polls fail with
network/`other` errors (not `auth_failed`).

**Command:** _(Lightsail SSH)_

```bash
sudo systemctl status aberp-site --no-pager
```

**WHY:** Tells you whether the Node service is alive at all before you chase anything
subtler.

If it's not `active (running)`, restart and check:

```bash
sudo systemctl restart aberp-site
curl -fsS http://127.0.0.1:3000/healthz && echo
sudo tail -20 /home/aberp/logs/aberp-site.err
```

**Expected after restart:** `/healthz` returns `ok`.

**If it fails:** `/healthz` returns `ok` but real requests still 503 → re-check the
F15/F8/F19 boot-checks in [1.4](#14--verify-the-f15-boot-check-passed); the `.err` log
names the exact missing env var. Service won't stay up at all → read the `.err` tail for
the fatal line (bad `EnvironmentFile`, port `:3000` already bound, missing `build/`).

---

## Phase 6 — Rollback toggle

The pilot rolls back **without taking the storefront down.** The storefront keeps
serving `/quote` and keeps queueing emails to disk; you only stop ABERP from _draining_
the queue. Queued entries simply wait — nothing is lost.

**WHERE: Mac terminal (the ABERP side — no storefront change needed).**

1. Stop the running ABERP (`Ctrl-C` in its terminal), then relaunch with the kill
   switch set:

   ```bash
   cd ~/Documents/Claude/Projects/ABERP
   ABERP_EMAIL_OUTBOX_POLL_DISABLED=true ./run/run_prod.sh
   ```

   **WHY:** `ABERP_EMAIL_OUTBOX_POLL_DISABLED` (truthy = `1` or `true`, case-insensitive)
   tells the daemon to stand down at boot. The storefront never learns or cares.

2. **Confirm it's disabled** — the boot log shows:

   ```
   email-outbox poll daemon disabled by env (S307 / PR-276)
   ```

   (If you instead see `email-outbox poll daemon spawned (S307 / PR-276)`, the var
   didn't take — check for a typo or a leftover `export` in `~/.aberp/prod/env.sh`.)

With the daemon disabled, `queued/` on Lightsail grows but nothing sends. Customers can
still submit; the acknowledgments wait safely in the queue.

**To resume:** drop the env var (or set it to `0`/`false`), `Ctrl-C`, and relaunch
`./run/run_prod.sh`. The daemon spawns, sweeps the backlog, and drains `queued/` on its
normal cadence.

> **Note:** disabling the poll daemon needs **no** storefront-side change and does
> **not** roll back the ABERP version. A full version rollback is a separate
> `./run/upgrade_prod.sh PROD_v<older>` — out of scope for a pilot abort.

---

## Reference — at a glance

**Storefront (`/etc/aberp-site.env` on Lightsail; service user `aberp`):**

| Var                                            | Purpose                                                       | Default / note                                   |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `ABERP_SITE_ADMIN_TOKEN`                       | Bearer for all `/api/internal/*` + priced/catalogue endpoints | **required**; must equal ABERP's keychain bearer |
| `ABERP_SITE_OPERATOR_EMAIL`                    | Inbox CC'd on customer mail (F8 boot-check)                   | **required**; missing → 503                      |
| `BODY_SIZE_LIMIT`                              | Request-body cap (F19 boot-check)                             | unit defaults to `52428800` (50 MB)              |
| `ABERP_SITE_EMAIL_OUTBOX_DIR`                  | Queue root (F15 boot-check)                                   | default `/home/aberp/data/email-outbox`          |
| `ABERP_SITE_EMAIL_OUTBOX_STALE_CLAIM_TTL_SECS` | Wedged-claim recovery window                                  | default `600`, clamp `[1, 86400]`                |

**ABERP (Mac — env + keychain):**

| Knob                                                      | Purpose                                 | Default / note                           |
| --------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| keychain `aberp.quote_intake.prod` / `quote_intake_token` | Bearer ABERP presents to the storefront | **required**; = `ABERP_SITE_ADMIN_TOKEN` |
| `ABERP_EMAIL_OUTBOX_POLL_SECS`                            | Poll cadence (seconds)                  | default `5`, clamp `[1, 3600]`           |
| `ABERP_EMAIL_OUTBOX_POLL_DISABLED`                        | Kill switch (rollback)                  | unset; `1`/`true` disables               |

**Audit events (ABERP ledger, `quote.*`):**

| Event                        | When                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `quote.email_outbox_fetched` | every poll cycle (incl. empty + errored; `error_class: auth_failed` on 401) |
| `quote.email_outbox_claimed` | daemon claimed an entry                                                     |
| `quote.email_outbox_sent`    | SMTP send + writeback succeeded                                             |
| `quote.email_outbox_failed`  | SMTP send failed, writeback recorded the failure                            |

**Endpoints (storefront exposes, ABERP consumes — all bearer-gated):**

| Method + path                                                    | Purpose                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/internal/email-queue?since=<iso>&after=<id>&limit=<n>` | list queued entries (runs F1 stale-claim sweep first)                    |
| `POST /api/internal/email-queue/{id}/claim`                      | atomic queued → claimed (409 if not claimable)                           |
| `POST /api/internal/email-queue/{id}/sent`                       | claimed → sent; body `{ "audit_id": "..." }`                             |
| `POST /api/internal/email-queue/{id}/failed`                     | claimed → failed; body `{ "error_class": "...", "error_detail": "..." }` |

**Key paths & names:**

| Thing                | Value                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| SSH login user       | `ubuntu@<lightsail-static-ip>`                                                        |
| Service user         | `aberp` (owns `/home/aberp/*`; login-less)                                            |
| systemd unit         | `aberp-site.service` (`User=aberp`, `WorkingDirectory=/home/aberp/current`)           |
| Release symlink      | `/home/aberp/current` → `/home/aberp/releases/<sha>/`                                 |
| Health endpoint      | `http://127.0.0.1:3000/healthz` → `ok`                                                |
| Storefront logs      | `/home/aberp/logs/aberp-site.{log,err}`                                               |
| Outbox root          | `/home/aberp/data/email-outbox/{queued,claimed,sent,failed}`                          |
| Deploy workflow      | "Deploy to AWS" (`.github/workflows/deploy.yml`); S3 + SSM, env `production` approval |
| On-box deploy script | `/home/aberp/lightsail-deploy.sh <sha>` (run via SSM, self-restarts systemd)          |

---

## See also

- `docs/adr/0009-storefront-as-queue-no-tunnel.md` — the architecture decision.
- `src/lib/server/email-outbox.ts` — queue store + F1 stale-claim sweep.
- `src/lib/server/boot-checks.ts` — F8 / F15 / F19 boot-checks.
- `src/hooks.server.ts` — `/healthz` exemption + the 503 refuse-to-serve gate.
- `.github/workflows/deploy.yml` + `bin/lightsail-deploy.sh` — deploy mechanics.
- `apps/aberp/src/email_outbox_poll_daemon.rs` (ABERP repo) — the poll daemon.
- `apps/aberp/src/quote_intake_credentials.rs` (ABERP repo) — the bearer keychain key.
