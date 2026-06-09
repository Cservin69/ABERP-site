# Option D end-to-end pilot walkthrough

**The morning-of runbook for Ervin's first real customer quote flow through prod.**

This is the last documentation step before the auto-quote pipeline runs live.
It walks the whole path — pre-flight on the Mac, storefront deploy on Lightsail,
bearer-token reconciliation, one real smoke submission, the failure modes you
might hit, and how to roll back without taking the storefront down.

Architecture is **ADR-0009 — storefront-as-queue, ABERP polls outbound, no
tunnel, no third party** (`docs/adr/0009-storefront-as-queue-no-tunnel.md`).
The one-paragraph version:

- The **storefront** (Lightsail, public at `https://abenerp.com`) writes every
  outbound email to a queue directory on its own disk and exposes a
  bearer-gated polling API.
- **ABERP** (Ervin's MacBook, loopback-only) makes **outbound HTTPS only**. It
  polls the storefront's email queue every ~5 seconds, claims each entry, sends
  it via ABERP's SMTP, and writes the result back.
- There is **no inbound path to the Mac**. No `cloudflared`, no Tailscale, no
  WireGuard. If the Mac is asleep, queue entries pile up on Lightsail and drain
  when it wakes.

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

> **Versions this walkthrough was written against:** ABERP `PROD_v2.27.11`,
> storefront `origin/main` at `b173a94` (S311 sweep). If you are on later
> versions, the env-var names and audit-event names below should still hold —
> they are pinned in code, not in this doc.

> **Tenant placeholder:** every `prod` below is the ABERP tenant id. `prod` is
> the default `run/upgrade_prod.sh` uses. If your tenant directory under
> `~/.aberp/` is named something else, substitute it everywhere you see `prod`.

---

## Phase 0 — Pre-flight on the Mac (ABERP side)

Goal: confirm ABERP is on `PROD_v2.27.11`, its keychain secrets are present, and
it has booted and written its runtime descriptor.

### 0.1 — Upgrade ABERP to PROD_v2.27.11

**WHERE: Mac terminal**

First make sure the prod ABERP process is **not** running (the upgrade script
refuses to swap a running binary). If you have a `run_prod.sh` terminal open,
go to it and press `Ctrl-C`.

Then, from the ABERP repo checkout (the prod working copy, **not** a dev
workspace):

```
cd ~/Documents/Claude/Projects/ABERP
./run/upgrade_prod.sh PROD_v2.27.11
```

This validates the version string, snapshots the prod DB, does a clean
`git fetch` + checkout of the `PROD_v2.27.11` branch, verifies the tree is
clean, and then `exec`s `run/run_prod.sh` — so the same terminal becomes the
live ABERP server. Leave it running.

**Expected output (tail):**

```
[upgrade_prod] HEAD now at origin/PROD_v2.27.11 — clean
[upgrade_prod] exec ./run/run_prod.sh
...
boot step: reading session token from OS keychain (may prompt for keychain access)
...
email-outbox poll daemon spawned (S307 / PR-276)
```

The line `email-outbox poll daemon spawned` is the one that matters — it means
the polling daemon is alive. If you instead see
`email-outbox poll daemon: DISABLED via ABERP_EMAIL_OUTBOX_POLL_DISABLED`, the
kill switch from a prior rollback is still set; see
[Phase 6 — Rollback](#phase-6--rollback-plan) to unset it.

> **macOS keychain prompts:** boot reads several keychain entries in a burst.
> If macOS pops "ABERP wants to use your keychain", click **Always Allow** so
> later cycles don't re-prompt.

### 0.2 — Verify the keychain entries are present

**WHERE: Mac terminal**

ABERP needs three classes of keychain secret for this pilot. Check each:

```
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w >/dev/null && echo "OK: quote_intake bearer"
security find-generic-password -s "aberp.smtp.prod" -w >/dev/null 2>&1 && echo "OK: smtp password (entry present)"
security find-generic-password -s "aberp.nav.prod" -w >/dev/null 2>&1 && echo "OK: nav credentials (entry present)"
```

**Expected output:**

```
OK: quote_intake bearer
OK: smtp password (entry present)
OK: nav credentials (entry present)
```

The **`aberp.quote_intake.prod` / `quote_intake_token`** entry is the
load-bearing one for this pilot — it is the **bearer token ABERP presents to
the storefront** on every poll/claim/sent/failed call. Hold onto its value; you
will reconcile it against the storefront in [Phase 2](#phase-2--bearer-token-reconciliation).
To print the actual value (you'll need it shortly):

```
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w
```

> **Why this exact key?** The email-outbox poll daemon does **not** use a
> dedicated email token. It reuses the shared _storefront credential_ — the same
> base-URL + bearer the quote-intake and catalogue-push daemons use
> (`apps/aberp/src/storefront_credential.rs`). That credential's bearer is read
> from the keychain entry above
> (`apps/aberp/src/quote_intake_credentials.rs`: service
> `aberp.quote_intake.<tenant>`, account `quote_intake_token`). One token, one
> keychain entry — see the finding note in [Phase 2](#phase-2--bearer-token-reconciliation).

### 0.3 — Verify the runtime descriptor exists

**WHERE: Mac terminal**

ABERP writes `~/.aberp/<tenant>/runtime.json` on every successful boot and
deletes it on graceful shutdown. Its presence confirms the server booted
cleanly this session.

```
cat ~/.aberp/prod/runtime.json
```

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

Confirm `started_at` is from **this** boot (within the last few minutes), not a
stale crash leftover. If the file is missing, ABERP did not finish booting — go
back to 0.1 and read the terminal for a fatal line.

> `relay_token_keychain_service` points at the **deprecated** push-relay token
> (ADR-0007, now superseded). It is _not_ the bearer this pilot uses; ignore it.
> The pilot bearer is the `quote_intake_token` from step 0.2.

---

## Phase 1 — Deploy the storefront to Lightsail

Goal: get `origin/main` at `b173a94` (or the current S311 tip) live on Lightsail
and confirm the F15 boot-check passes (the email-outbox directory is writable).

> **How storefront deploys actually work (read this — it differs from a manual
> `git pull`):** the Lightsail box has **no git checkout**. Deploys are
> artifact-based: pushing to `main` triggers `.github/workflows/deploy.yml`,
> which builds the server bundle in CI, uploads it to S3, and runs
> `bin/lightsail-deploy.sh <sha>` on the box via SSM Run Command. That script
> swaps the `~/aberp/current` symlink to `releases/<sha>` and restarts the
> systemd service. So you do not SSH in and pull — you trigger CI and then SSH
> in to **verify**.

### 1.1 — Confirm the deploy ran (or trigger it)

**WHERE: GitHub web**

`b173a94` is already on `origin/main`, so the push-triggered deploy has most
likely already run. Confirm it:

1. Open the repo → **Actions** tab → **Deploy to AWS** workflow.
2. Find the run for commit `b173a94` ("S311 follow-up: F15 canonical path…").
3. Confirm it is **green**.

If there is no run for `b173a94`, or you want to force a fresh one, trigger it
manually: **Actions → Deploy to AWS → Run workflow → branch `main` → Run
workflow.** Wait for it to go green (build → S3 sync → SSM deploy → health
check).

### 1.2 — SSH in and verify the live release

**WHERE: SSH into Lightsail**

```
ssh aberp@<lightsail-static-ip>
```

Confirm the service is up and which release is live:

```
sudo systemctl status aberp-site --no-pager
readlink -f /home/aberp/current
```

**Expected output:**

```
● aberp-site.service - ABERP-site SvelteKit Node server
     Loaded: loaded (/etc/systemd/system/aberp-site.service; enabled; ...)
     Active: active (running) since ...
...
/home/aberp/releases/b173a94...        <- the release dir is named by commit SHA
```

The `releases/<sha>` directory name should start with `b173a94` (the deploy
script names release dirs by the deployed commit SHA). If it shows an older
SHA, the deploy in 1.1 didn't land — re-trigger it.

Confirm the server answers its health probe:

```
curl -fsS http://127.0.0.1:3000/healthz
```

**Expected output:**

```
ok
```

> If `/healthz` returns `ok` but other requests return **503**, the boot-checks
> failed (see 1.3) — `/healthz` is intentionally exempt so the deploy
> health-probe can still pass, but every real request 503s until the boot
> problem is fixed.

### 1.3 — Verify the F15 boot-check passed (outbox dir writable)

**WHERE: SSH into Lightsail**

S311's F15 boot-check refuses to serve (503 on every non-`/healthz` request) if
the email-outbox directory is missing, not absolute, or not writable. The
canonical path is **`/home/aberp/data/email-outbox`** (this is the S311 default;
it does not need to be set in the env). Confirm the directory tree exists and is
writable by the `aberp` user:

```
ls -ld /home/aberp/data/email-outbox /home/aberp/data/email-outbox/{queued,claimed,sent,failed}
touch /home/aberp/data/email-outbox/.pilot-write-test && rm /home/aberp/data/email-outbox/.pilot-write-test && echo "OK: outbox writable"
```

**Expected output:**

```
drwxr-xr-x 6 aberp aberp 4096 ... /home/aberp/data/email-outbox
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/queued
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/claimed
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/sent
drwxr-xr-x 2 aberp aberp 4096 ... /home/aberp/data/email-outbox/failed
OK: outbox writable
```

The directories are created automatically on first boot/enqueue, so an empty
tree is fine — what matters is the `touch`/`rm` round-trip succeeding as the
`aberp` user.

Also confirm the boot-check did not log a problem:

```
grep -E "boot-check (F15|F8|F19)" /home/aberp/logs/aberp-site.err | tail -5
```

**Expected output:** _(empty — no boot-check problems)_

If you see an `F15` line, the systemd unit's `ReadWritePaths=` is wrong or the
path was overridden to something non-writable; the log message names the exact
fix. (The shipped unit at `docs/aws/aberp-site.service` whitelists
`/home/aberp/data`, which is why the default path passes out of the box.)

---

## Phase 2 — Bearer-token reconciliation

Goal: the token ABERP presents **must byte-for-byte equal** the token the
storefront expects. If they differ, every poll 401s and **no emails send** —
silently, except for the audit rows you'll learn to read in
[Phase 5](#phase-5--failure-mode-walkthroughs).

> **⚠️ Finding — key name differs from the dispatch brief.** The pilot brief
> guessed a keychain key of `aberp.storefront.bearer`. **That key does not
> exist.** The real reconciliation is:
>
> | Side                       | Where the token lives | Name                                                            |
> | -------------------------- | --------------------- | --------------------------------------------------------------- |
> | **Mac (ABERP)**            | OS keychain           | service `aberp.quote_intake.prod`, account `quote_intake_token` |
> | **Storefront (Lightsail)** | `/etc/aberp-site.env` | env var `ABERP_SITE_ADMIN_TOKEN`                                |
>
> There is **one** shared secret, not a new email-specific one — ADR-0009 §Auth
> deliberately reuses the existing storefront-admin token. The same token also
> gates the priced-writeback and catalogue endpoints, so if quotes already flow,
> the token is already correct and you can skip the _generate_ step.

### 2.1 — Read the token ABERP will present (Mac)

**WHERE: Mac terminal**

```
security find-generic-password -s "aberp.quote_intake.prod" -a "quote_intake_token" -w
```

Copy the value. This is `TOKEN_ABERP`.

### 2.2 — Read the token the storefront expects (Lightsail)

**WHERE: SSH into Lightsail**

```
sudo grep '^ABERP_SITE_ADMIN_TOKEN=' /etc/aberp-site.env
```

**Expected output:**

```
ABERP_SITE_ADMIN_TOKEN=<some-long-token>
```

This value (after the `=`) is `TOKEN_STOREFRONT`.

### 2.3 — Make them match

**WHERE: Mac terminal + SSH into Lightsail**

Compare `TOKEN_ABERP` and `TOKEN_STOREFRONT`. **If they are identical, you are
done — skip to Phase 3.**

If they differ (or either is missing), pick the storefront's value as the source
of truth and write it into the Mac keychain. The cleanest operator path is via
the ABERP SPA, which writes both the keychain entry and `seller.toml`
atomically and **hot-reloads the daemon with no restart**:

**WHERE: SPA (Settings → Quote Intake)**

1. Open the ABERP SPA → **Settings → Quote Intake**.
2. Set **Base URL** to `https://abenerp.com` (no trailing slash needed).
3. Paste `TOKEN_STOREFRONT` into the **Bearer token** field.
4. Save. The next poll cycle (≤ ~5 s later) uses the new value — no ABERP
   restart required.

If you cannot reach the SPA, set the keychain entry directly instead:

**WHERE: Mac terminal**

```
security add-generic-password -U -s "aberp.quote_intake.prod" -a "quote_intake_token" -w '<TOKEN_STOREFRONT>'
```

The `-U` flag updates the entry in place if it already exists. Because the
keychain entry is read on the _next_ poll cycle via the shared credential
handle, you do **not** need to restart ABERP after a `security add-generic-password`
that the SPA didn't make — but if in doubt, `Ctrl-C` the ABERP terminal and
re-run `./run/run_prod.sh`.

> **If you must generate a brand-new token** (first-ever setup): generate a
> strong one on the Mac with `openssl rand -hex 32`, write it to **both** sides
> — `ABERP_SITE_ADMIN_TOKEN=` in `/etc/aberp-site.env` on Lightsail (then
> `sudo systemctl restart aberp-site`), and the keychain entry on the Mac (via
> the SPA or `security add-generic-password` above).

---

## Phase 3 — End-to-end smoke (one real submission)

Goal: push one real STEP file through `abenerp.com/quote` and watch it travel
queued → claimed → sent, with matching audit rows in ABERP.

Keep three windows open: a **browser**, an **SSH session to Lightsail**, and the
**ABERP SPA**.

### 3.1 — Submit a quote

**WHERE: Mac browser**

1. Open `https://abenerp.com/quote`.
2. Upload a STEP file (`.step` / `.stp`). Fill in the contact email — use **your
   own inbox** so you can confirm receipt.
3. Submit.

**Expected:** the page shows an immediate **"received"** acknowledgment (the SPA
does not wait for ABERP — the submission is persisted and the acknowledgment
email is _enqueued_, not sent inline).

### 3.2 — Confirm the email landed in the queue

**WHERE: SSH into Lightsail**

```
ls -t /home/aberp/data/email-outbox/queued/
```

**Expected output:** one new `<ULID>.json` file (26-char id, e.g.
`01J9Z3K8...json`). Inspect it:

```
cat /home/aberp/data/email-outbox/queued/$(ls -t /home/aberp/data/email-outbox/queued/ | head -1)
```

**Expected output (abridged):**

```json
{
	"id": "01J9Z3K8...",
	"queued_at": "2026-06-09T07:35:01.123Z",
	"to": ["you@example.com"],
	"subject": "...",
	"submitter": "submission_received",
	"state": "queued",
	"attempt_n": 0,
	"claimed_at": null
}
```

### 3.3 — Wait for ABERP to poll, claim, and send

**WHERE: SSH into Lightsail**

The poll cadence is **5 seconds** by default
(`ABERP_EMAIL_OUTBOX_POLL_SECS`, clamped to `[1, 3600]`). Within ~5–10 s the
entry should move out of `queued/` and into `sent/`:

```
ls /home/aberp/data/email-outbox/queued/ /home/aberp/data/email-outbox/sent/
```

**Expected output:** the id is now in `sent/`, gone from `queued/`. If you catch
it mid-flight you may briefly see it in `claimed/` — that's the optimistic lock
held while ABERP's SMTP send is in progress; it should not linger more than a few
seconds.

Inspect the sent record — it now carries `sent_at` and an `audit_id`:

```
cat /home/aberp/data/email-outbox/sent/$(ls -t /home/aberp/data/email-outbox/sent/ | head -1)
```

**Expected output (abridged):**

```json
{
	"id": "01J9Z3K8...",
	"state": "sent",
	"attempt_n": 1,
	"sent_at": "2026-06-09T07:35:06.456Z",
	"audit_id": "01J9Z3K9...",
	"claimed_at": "2026-06-09T07:35:06.001Z"
}
```

### 3.4 — Confirm the submission shows in ABERP

**WHERE: SPA (Auto-árazás)**

Open the ABERP SPA → **Auto-árazás**. The new submission should appear in the
intake list (the quote-intake daemon polls `GET /api/quotes?status=received` on
its own ~60 s cadence, so this can lag the email by up to a minute — that's
expected and independent of the email poll).

### 3.5 — Confirm the audit trail

**WHERE: SPA (Audit log)** — or **WHERE: Mac terminal** if you prefer the CLI

In the ABERP SPA audit view, filter for the email-outbox events. You should see,
for this flow:

- `quote.email_outbox_fetched` — emitted every poll cycle (carries
  `fetched_count`; fires even on empty cycles).
- `quote.email_outbox_claimed` — the daemon claimed your entry.
- `quote.email_outbox_sent` — SMTP send + writeback succeeded.

(`quote.email_outbox_failed` only appears on a send failure — you should **not**
see it for a healthy flow.)

### 3.6 — Confirm the email arrived

**WHERE: Mac browser (your inbox)**

The `submission_received` acknowledgment email should be in your inbox. Per
ADR-0009's validation criterion, the full pilot also expects a `priced_ready`
email (after you run pricing in the SPA and it writes the priced PDF back) and
an `accept_confirmation` email (after you click accept on the customer status
page). Repeat 3.2–3.6 for each — each is just another entry flowing through the
same queued → claimed → sent path with a different `submitter`.

---

## Phase 4 — What "healthy steady state" looks like

Once the pilot is running, this is the baseline so you can tell normal from
wrong at a glance:

- `queued/` is **empty or near-empty** most of the time (entries drain within
  ~5 s).
- `claimed/` is **empty** between sends (an entry sitting in `claimed/` for more
  than a minute is the wedge described in [Phase 5.1](#51--wedged-claim-recovery-no-operator-action)).
- `sent/` and `failed/` **accumulate** — they are the durable audit trail. There
  is no auto-cleanup in v1 (ADR-0009 open question 2); a handful of KB per quote
  is fine for the pilot.
- The SPA's email-outbox status panel shows `spawned: true`, a recent
  `last_poll_ts`, and `entries_in_progress: 0` between sends.

---

## Phase 5 — Failure-mode walkthroughs

### 5.1 — Wedged claim recovery (no operator action)

**Symptom:** an entry sits in `/home/aberp/data/email-outbox/claimed/` and does
not move to `sent/` or `failed/`.

**Cause:** ABERP claimed the entry (atomic `queued → claimed` rename), then
crashed or lost the writeback _after_ the SMTP send but _before_ posting
`.../sent`. The daemon's normal cycle only scans `queued/`, so without recovery
the entry would be stranded forever.

**What happens automatically (S311 / F1 — `recoverStaleClaimed`):** on every
`GET /api/internal/email-queue` call, the storefront first sweeps `claimed/` and
atomically renames any entry whose `claimed_at` is older than the stale-claim
TTL back to `queued/`. The daemon then re-claims and re-sends it on a later
cycle.

**Operator action: none.** Just wait **one TTL window**. The default TTL is
**600 seconds (10 minutes)** (`ABERP_SITE_EMAIL_OUTBOX_STALE_CLAIM_TTL_SECS` on
the storefront, clamped to `[1, 86400]`). After that window the entry
reappears in `queued/` and drains normally.

> **Trade-off to know about:** if ABERP actually _did_ send the email but only
> the writeback failed, recovery re-sends it — the customer gets a duplicate.
> This is accepted for the pilot's single-digit-emails-per-day volume
> (ADR-0009 Consequences §3). Do not "fix" a wedged claim by hand; let the
> sweep handle it.

To override the TTL (e.g. shorten it for a test), set the env var on Lightsail:

**WHERE: SSH into Lightsail**

```
echo 'ABERP_SITE_EMAIL_OUTBOX_STALE_CLAIM_TTL_SECS=120' | sudo tee -a /etc/aberp-site.env
sudo systemctl restart aberp-site
```

### 5.2 — Mac asleep mid-submission

**Symptom:** you submit a quote while the MacBook lid is closed; nothing sends.

**This is expected and self-healing.** The submission persists into `queued/` on
Lightsail. ABERP isn't polling while asleep, so the entry waits. When the Mac
wakes, the daemon's next cycle (≤ ~5 s after the network comes back) fetches and
sends it.

**Operator action: none.** Open the lid; watch `queued/` drain.

### 5.3 — 401 Unauthorized (bearer mismatch)

**Symptom:** emails never send, `queued/` keeps growing, nothing reaches
`claimed/`.

**Cause:** the token ABERP presents no longer matches
`ABERP_SITE_ADMIN_TOKEN` on the storefront — almost always because one side was
rotated without the other.

**How to confirm which side is wrong (S311 / F18):** errored poll cycles now
emit an audit row, so the failure is visible instead of silent. In the ABERP
SPA audit log, look for `quote.email_outbox_fetched` rows with the error fields
populated and **`error_class: auth_failed`**. Seeing those once per poll cycle
(rather than silence) is the signal that the bearer is mismatched, not that the
daemon is dead or the queue is empty.

**Fix:** re-run [Phase 2](#phase-2--bearer-token-reconciliation) — read both
sides, make them match. The fastest fix is the SPA path (2.3), which hot-reloads
without a restart.

### 5.4 — Storefront systemd service dead

**Symptom:** `https://abenerp.com/quote` is down, or ABERP polls fail with
network/`other` errors (not `auth_failed`).

**WHERE: SSH into Lightsail**

```
sudo systemctl status aberp-site --no-pager
```

If it is not `active (running)`, restart it and check the logs:

```
sudo systemctl restart aberp-site
sleep 3
curl -fsS http://127.0.0.1:3000/healthz && echo
tail -20 /home/aberp/logs/aberp-site.err
```

**Expected after restart:** `/healthz` returns `ok`. If it returns `ok` but real
requests 503, re-check the F15/F8/F19 boot-checks in
[Phase 1.3](#13--verify-the-f15-boot-check-passed-outbox-dir-writable) — the
`.err` log names the exact missing env var.

---

## Phase 6 — Rollback plan

The pilot is designed to roll back **without taking the storefront down**. The
storefront keeps serving `/quote` and keeps queueing emails to disk; you only
stop ABERP from draining the queue. Queued entries simply wait — nothing is
lost.

**WHERE: Mac terminal**

1. Set the kill switch and restart ABERP:

   ```
   echo 'export ABERP_EMAIL_OUTBOX_POLL_DISABLED=true' >> ~/.aberp/prod/env.sh
   ```

   …or set it inline for the launch. Then stop the running ABERP (`Ctrl-C` in
   its terminal) and relaunch:

   ```
   cd ~/Documents/Claude/Projects/ABERP
   ABERP_EMAIL_OUTBOX_POLL_DISABLED=true ./run/run_prod.sh
   ```

2. **Confirm it's disabled.** The boot log should show:

   ```
   email-outbox poll daemon: DISABLED via ABERP_EMAIL_OUTBOX_POLL_DISABLED
   ```

   (Accepted truthy values: `1` or `true`, case-insensitive.)

With the daemon disabled, `queued/` on Lightsail grows but nothing sends. The
storefront is completely unaffected — customers can still submit, and the
acknowledgments wait safely in the queue.

**To resume:** remove the env var (or set it to `0`/`false`), `Ctrl-C`, and
relaunch `./run/run_prod.sh`. The daemon spawns, sweeps the backlog, and drains
`queued/` on its normal cadence.

> **Note:** disabling the poll daemon does **not** require any storefront-side
> change and does **not** roll back the ABERP version. If you need a full
> version rollback, that's a separate `./run/upgrade_prod.sh PROD_v<older>` —
> out of scope for a pilot abort.

---

## Reference — env vars and audit events at a glance

**Storefront (`/etc/aberp-site.env` on Lightsail):**

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

---

## See also

- `docs/adr/0009-storefront-as-queue-no-tunnel.md` — the architecture decision.
- `src/lib/server/email-outbox.ts` — queue store + F1 stale-claim sweep.
- `apps/aberp/src/email_outbox_poll_daemon.rs` (ABERP repo) — the poll daemon.
- `apps/aberp/src/quote_intake_credentials.rs` (ABERP repo) — the bearer keychain key.
