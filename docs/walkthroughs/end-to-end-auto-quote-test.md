# Walkthrough — End-to-end auto-quote test

**Goal:** drive one real customer quote from submission to acceptance to DEAL with material commit, exercising every wire seam that S276–S283 (storefront) and the ABERP-side auto-quote arc (closed at `PROD_v2.27.2`) shipped. After this walkthrough completes, the pipeline is validated end-to-end on production.

**Audience:** Ervin (operator). Schoolboy-with-hands format per `[[walkthrough-format]]`. Every step is WHERE-tagged. One screen of action per step. AWS Console preferred over CLI.

**Scope:** one quote, one material, one customer. Multi-tenant, prefetch hardening, and storefront→ABERP network topology in prod are out of scope (see §"Open questions" at the end).

**Reversibility:** the walkthrough mutates ABERP DuckDB rows (`pricing jobs`, `audit_events`, `inventory_committed`) and storefront `/data/quotes/<id>/` directories. To reset: reject the quote in ABERP (clears the WO) and `rm -rf /data/quotes/<UUID>` on the Lightsail box. No external systems are mutated unless you click DEAL — DEAL writes a Sales Order, a Work Order, and a material commit.

**Time budget:** ~15 minutes hands-on across ~30 minutes wall-clock (the ABERP poll daemon's cadence is 60s).

---

## Local-dev test path (achievable today, 2026-06-09)

**Read this first if you are running the test against a Mac-hosted ABERP and a `npm run dev` storefront on the same machine.** The Preflight section below is written for the eventual prod topology; today's reality (the storefront still cannot reach ABERP across the public internet — open question #3) is that the only achievable end-to-end run is local-dev. **As of `PROD_v2.27.7` (S291 shipped 2026-06-09), the five operator-discipline steps that used to gate this run are collapsed into a single command.**

### Primary path — run `./run/dev-test.sh`

**[Mac terminal]** From the ABERP checkout:

```sh
cd /Users/aben/Documents/Claude/Projects/ABERP
./run/dev-test.sh
```

That launcher (S291 / PR-272, shipped 2026-06-09):

- pins the ABERP HTTPS loopback to port `18443` (no more `lsof` hunt after every restart);
- mints the `aberp.email_relay.test.email_relay_token` Keychain entry on first run, reuses it after;
- starts ABERP with `ABERP_DEV_MODE=1` + `ABERP_SISTER_SERVICE_BASE_URL=http://localhost:5173`;
- waits for ABERP's atomic-written `~/.aberp/<tenant>/runtime.json` discovery file;
- exports the matching env vars + starts the storefront's `npm run dev`;
- opens `http://localhost:5173/quote` in your default browser when both are up.

Skip directly to the Preflight section once both processes are running (the launcher tails their logs in the same terminal). **Per `[[trust-code-not-operator]]`: the launcher IS the operator discipline.**

### Advanced — manual LD-1..LD-5 (non-Mac or operator-debugging only)

Use this collapsed sequence ONLY if the launcher above is unavailable (e.g. running ABERP on Linux, or stepping through the seams for debugging). Skip otherwise.

#### LD-1 — [Mac terminal] Find ABERP's current loopback port

If you ran `dev-test.sh` it pinned the port to `18443`. If not, ABERP binds with `port=0` (OS-assigned). Discover the running port:

```sh
lsof -nP -i4TCP -sTCP:LISTEN -c aberp
```

The line with the high-numbered port (e.g. `60443`, `52017`) is ABERP. Note it for LD-4.

#### LD-2 — [ABERP SPA] Point ABERP at the local storefront

ABERP → **Maintenance → Quote Intake → Base URL** → change from `https://abenerp.com` to `http://localhost:5173`. Save.

This is what tells the catalogue-push daemon and the priced-writeback poster to dial the local Vite dev server instead of prod. If you skip this you will push the catalogue snapshot to prod and the local storefront's catalogue will be empty (or stale) — the material-grade alignment warning in Step 1 fires.

**Shipped in `PROD_v2.27.5` (S289 / PR-270):** catalogue-push hot-reloads the URL change without an ABERP restart, AND a dev-mode prod-URL boot/PUT warning catches `ABERP_DEV_MODE=1` + prod URL typos. The SPA toggle is still the operator's first action, but a typo no longer silently hammers prod.

#### LD-3 — [Mac terminal] Provision the email relay token in Keychain

```sh
TOKEN=$(openssl rand -hex 32)
security add-generic-password \
  -a "$USER" \
  -s "aberp.email_relay.test.email_relay_token" \
  -w "$TOKEN"
echo "$TOKEN"   # copy this — needed in LD-4
```

**Tenant name is `test`, not `prod`** — matches `dev-test.sh`'s `DEFAULT_TENANT="test"` (S296 review F38). If you mint under `prod`, the launcher would mint a second `test` token on its next run and you would accumulate orphan keychain entries.

The same token has to be the bearer ABERP's `/api/internal/send-email` accepts and the bearer the storefront's `email-relay.ts` sends. If only one side has it, the relay returns 401 and the "your quote is ready" email is silently swallowed (logged, not raised — ADR-0007 §"Negative").

#### LD-4 — [Storefront terminal] Start dev with all five env vars

From the ABERP-site checkout:

```sh
ABERP_SITE_PUBLIC_URL=http://localhost:5173 \
ABERP_INTERNAL_BASE_URL=https://127.0.0.1:<port-from-LD-1> \
ABERP_EMAIL_RELAY_TOKEN=<token-from-LD-3> \
BODY_SIZE_LIMIT=52428800 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
npm run dev
```

The `NODE_TLS_REJECT_UNAUTHORIZED=0` is because ABERP's loopback listener uses a self-signed cert. Local-dev only — production uses a real TLS terminus.

#### LD-5 — Sanity check before Step 1

- Hit `http://localhost:5173/quote` in your browser — the form renders.
- ABERP → **Auto-árazás** tab shows "Daemon active, polling every 60s."
- Tail `npm run dev` logs in the storefront terminal — no `BODY_SIZE_LIMIT` warning, no `EmailRelayError('unconfigured')` on boot.

If any of those fails, back up and re-do the corresponding LD-step. **Skip Preflight 3 (the `/etc/aberp-site.env` checks) and Preflight 5 (the Lightsail `BODY_SIZE_LIMIT` check) — those are Lightsail-only.** Preflight 1 (ABERP version), Preflight 2 (storefront SHA — replace with `git -C $PWD log -1 --oneline` against your local checkout), and Preflight 4 (daemon active) still apply.

**Forward link:** S291's `./run/dev-test.sh` shipped in `PROD_v2.27.7` (2026-06-09) and is now the primary path above. Once S299's network-topology ADR closes (Cloudflare Tunnel / Tailscale / public TLS / polling-only — see ADR-0008, Option B Accepted 2026-06-09), the prod-style preflight below becomes achievable without local-dev workarounds.

---

## Preflight

Run all five preflight checks before starting Step 1 of the test path. Each verifies one boundary that has to be true for the pipeline to advance.

### Preflight 1 — ABERP is on PROD_v2.27.2 or later

**[ABERP desktop]** Open ABERP. The top-bar version indicator should read `PROD_v2.27.2` or a higher PATCH/MINOR/MAJOR.

**If it does not:**

**[Local Mac terminal]** From the ABERP checkout (not this storefront checkout):

```sh
cd /Users/aben/Documents/Claude/Projects/ABERP
./run/upgrade_prod.sh PROD_v2.27.2
```

Restart ABERP, re-check the version indicator.

**Why this version matters:** S281 shipped the pricing daemon; S282 (`PROD_v2.27.2`) auto-provisions the Python venv for the CAD extractor so the operator never has to set `ABERP_QUOTE_PIPELINE_PYTHON` by hand (`[[aberp-python-auto-discovery]]`). Without that, the daemon will start in dormant state and Step 4 below will hang in "Fetched."

---

### Preflight 2 — Storefront is on `708bf83` or later

**[Local Mac terminal]** From this checkout:

```sh
git -C /Users/aben/Documents/Claude/Projects/ABERP-site rev-parse origin/main
```

You should see `708bf83…` or a newer SHA (the S284 walkthrough commit itself is newer, that's fine).

**[GitHub.com]** Open https://github.com/Cservin69/ABERP-site/commits/main and confirm the top commit on `main` is the one served by Lightsail. Lightsail's GitHub Actions deploy lane pulls from `main` automatically; if the latest commit on `main` is older than `708bf83`, deploy is stuck — investigate Actions before proceeding.

**Why:** `708bf83` is S283/PR-04 (HMAC accept link + ABERP email relay). Without it, the priced-writeback flow has nowhere to send the "your quote is ready" email and the accept route doesn't exist.

---

### Preflight 3 — `ABERP_EMAIL_RELAY_TOKEN` and `ABERP_INTERNAL_BASE_URL` are set on the storefront

**[AWS Console]** AWS Console → **Lightsail** → Instances → `ABERP-site` (or whatever the instance is named) → **Connect using SSH**.

A Browser SSH session opens.

**[Browser SSH]**

```sh
sudo grep -E '^ABERP_(INTERNAL_BASE_URL|EMAIL_RELAY_TOKEN)=' /etc/aberp-site.env
```

You should see **two** non-empty lines, e.g.:

```
ABERP_INTERNAL_BASE_URL=http://127.0.0.1:8080
ABERP_EMAIL_RELAY_TOKEN=<long random string>
```

**If `ABERP_EMAIL_RELAY_TOKEN` is missing or empty:**

**[ABERP desktop]** Open Keychain (Settings → Secrets / `[[aberp-smtp-spoc]]` SPOC entry) and copy the value of `email_relay_token` (it's the bearer the ABERP `/api/internal/send-email` endpoint checks against — same secret on both sides).

**[Browser SSH]**

```sh
sudo $EDITOR /etc/aberp-site.env
# add (or fix):
#   ABERP_EMAIL_RELAY_TOKEN=<paste from ABERP keychain>
sudo systemctl restart aberp-site
```

**If `ABERP_INTERNAL_BASE_URL` is missing or empty:**

This is the URL the storefront uses to reach ABERP's relay endpoint. **Today's reality:** ABERP runs on Ervin's Mac and is not internet-reachable; for first-time end-to-end testing, this needs to be a path the Lightsail box can dial. Two options:

- **Local-dev variant** (run the storefront on your Mac alongside ABERP): set `ABERP_INTERNAL_BASE_URL=http://127.0.0.1:8080` in your shell, then `npm run dev` — both processes can see each other on loopback. Use this for the first dry run.
- **Prod variant** (Lightsail → ABERP across the internet): TBD — needs a public ABERP TLS terminus or a tunnel. **Flagged in §"Open questions" — do not block the walkthrough on it; instead, run the first end-to-end test in the local-dev variant and document the prod topology as a follow-up.**

**Why:** PR-04 routes the customer "your quote is ready" email through ABERP. Without these two env vars set, the storefront throws `EmailRelayError('unconfigured')` and the email-send step in the priced-writeback handler is a silent no-op (logged, not raised, by design — see ADR-0007 §"Negative").

---

### Preflight 4 — ABERP pricing daemon is active

**[ABERP desktop]** Open ABERP → **Auto-árazás** tab.

You should see the empty-state card reading: **"Daemon active, polling every 60s. No pending submissions on storefront."**

**You should NOT see:**

- A **RED** card "Daemon dormant — Python venv not detected." → run `./run/upgrade_prod.sh PROD_v2.27.2` per Preflight 1; the upgrade script auto-provisions the venv.
- A **RED** card "Daemon failed to start" → click the log link, surface the error in `[[aberp-python-auto-discovery]]` follow-up.

**Why:** the daemon is what pulls newly-submitted quotes from the storefront, runs the CAD extractor, calls the Rust scoring engine, and POSTs the priced artifact back. If it's dormant, nothing on the storefront will advance past `received`.

---

### Preflight 5 — Storefront `BODY_SIZE_LIMIT` is at least 50 MB

**[Browser SSH]** (same SSH session as Preflight 3):

```sh
sudo journalctl -u aberp-site --since '1 hour ago' | grep -i body_size_limit | tail -3
```

You should see **no warning lines**, or — on a fresh restart — at most one acknowledging the configured value. If you see:

```
[aberp-site] BODY_SIZE_LIMIT=(unset, adapter-node default 524288) < 52428800. ...
```

…the storefront is running with adapter-node's stock 512 KB body cap. Step 3's priced PDF writeback and Step 1's CAD upload will both 413 at the adapter layer before the SvelteKit handlers see them.

**To fix:**

```sh
sudo grep BODY_SIZE_LIMIT /etc/aberp-site.env
# should print:  BODY_SIZE_LIMIT=52428800
# if missing or empty, add the line (a fresh bootstrap via lightsail-bootstrap.sh
# writes it; older boxes may need a manual edit):
sudo $EDITOR /etc/aberp-site.env
sudo systemctl restart aberp-site
```

`docs/aws/aberp-site.service` also pins this via `Environment=BODY_SIZE_LIMIT=52428800` as a fallback when `/etc/aberp-site.env` is silent. Reinstalling the unit (`sudo install -m 0644 docs/aws/aberp-site.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart aberp-site`) lifts the floor without any env-file edit.

**Why:** S285 review F1 — `docs/reviews/S285-adversarial-storefront-arc.md` — documented this as the #1 blocker for the first walkthrough run. Two endpoints exceed adapter-node's 512 KB default:

- `POST /api/quote` carries customer CAD up to 50 MB.
- `POST /api/quotes/{id}/priced` carries the priced PDF up to 6 MB (ADR-0004 design max).

The single env var has to be ≥ the larger of the two (= 50 MB). Setting it to 6 MB to "match" ADR-0004 breaks CAD upload — don't do that.

---

## Test path

Run the steps in order. Do not skip ahead even if a prior step seems to have completed early — the pipeline's wall-clock cadence is poll-driven (60s), and the verify lines depend on that.

### Step 1 — [abenerp.com browser] Submit a fresh quote

**[abenerp.com browser]** Open https://abenerp.com/quote in a fresh browser tab.

Fill the form:

- **Name:** `Walkthrough Test`
- **Email:** an address you can read (use the plus-trick: `you+walkthrough@yourdomain.com` so it's distinct from any prior test).
- **Material:** pick from the dropdown — **but type a grade from ABERP's seeded catalogue**: `6061-T6`, `7075-T651`, `304`, `316`, `Ti-6Al-4V`, `Inconel 718`, `PEEK`, or `MONEL_650`. The form's hardcoded dropdown fallback list does NOT match these grades; if you pick from the fallback list (e.g. "Aluminium 6061" without the `-T6` suffix), the pricing job fails with **"material grade `X` is not in the catalogue snapshot"** after the `Extracting` step. **Cause:** the catalogue push from ABERP to the local storefront still needs a one-shot Test-push from ABERP → Materials → "Teszt push" (shipped in PROD_v2.27.5 / S289) to seed the local Vite dev server with the up-to-date catalogue. Once seeded, the eight grades above are accepted; until you do the test push (or wait for the cadence push), type one of the eight grades manually. Also for the first end-to-end run, avoid materials with `stock_status != in_stock` so the addendum-2 banner test is a clean separate run later.
- **Quantity:** `5`.
- **Needed-by date:** any date ≥ 2 weeks from today.
- **CAD file:** upload **a simple known-good `.stl` or `.step` shape**. **STEP and STL both work as of `PROD_v2.27.8` (S292 / PR-273 — OCCT-backed STEP path shipped 2026-06-09).** Assemblies (multi-solid STEP) are explicitly rejected: ensure your STEP is a single-part solid; the row will surface "STEP file contains an assembly with N solids" if not. A 30×30×30 mm cube (either format) is the safest first try. For v1 success, also avoid shapes with thin walls, 5-axis features, or internal pockets — the OCCT extractor is stubbed for many feature classes. **STEP unit-of-measure normalisation** (PROD_v2.27.9 / S297 F2) silently converts `LENGTH_UNIT('METRE')` / `'CENTI METRE'` / `'INCH'` files to mm at import — but if your CAD tool emits the geometry coords AND the LENGTH_UNIT inconsistently (a Fusion bug class), inspect the bbox in the Pricing-job row's detail pane before clicking DEAL. **Other formats** (`.iges`, `.dxf`, `.sldprt`, `.obj`, …) are accepted at upload but fail at the extractor with a clear `Permanent` badge — the customer must re-upload in `.stl` / `.step` / `.stp`.
- **Notes:** leave blank or write `walkthrough-test`.
- **Honeypot fields:** do not touch (they are visually hidden — if you trigger them by tab-cycling, the submit will silently 400; redo).

Click **Submit**.

**Verify:** the page navigates to a confirmation view reading "Thanks — we have your request. Reference: `<UUID>`. We'll email you with pricing, usually within a few minutes (up to two business days if we're between batches)."

**Copy the reference (the UUID).** You will need it for Step 2.

---

### Step 2 — [Email inbox] Confirm the "submission received" email

**[Email inbox]** Within ~10s of submit, an email should arrive from the storefront. Subject: `Áben Consulting — Submission received, quote #<short-id>`. Body: bilingual HU + EN, "Köszönjük az ajánlatkérést / Thank you for your quote request — Your indicative quote will be ready within an hour." with a status-page link of the form `https://abenerp.com/q/<UUID>?t=<status-token>`.

This email is sent by the **PR-07 fire-and-forget path** in `/api/quote` (`sendSubmissionReceivedEmail`, ADR-0007 relay). The handler returns 200 immediately and queues the send via `setImmediate`, so a slow or broken relay never blocks the customer. **If it doesn't arrive, see Troubleshooting §"No email arrives" — but the customer still got their reference id on the confirmation page, so the rest of the walkthrough is unblocked.**

Its arrival is the first real validation that:

- The storefront's `email-relay.ts` reached `ABERP_INTERNAL_BASE_URL`.
- ABERP's `/api/internal/send-email` accepted the bearer (`ABERP_EMAIL_RELAY_TOKEN` matched).
- ABERP's downstream SMTP sent the message.

**Verify:** the email is in your inbox within 5 minutes. The body contains a "view your quote status" link of the form `https://abenerp.com/q/<UUID>?t=<status-token>`.

**If no email arrives within 5 minutes:** see Troubleshooting §"No email arrives."

**Click the status link.** It opens the customer-side status page showing state `Beérkezett / Received` — there is no priced content yet (that comes in Step 5). Keep this tab open; you will refresh it later.

---

### Step 3 — [ABERP desktop] Watch the pricing job appear in Auto-árazás

**[ABERP desktop]** Switch to ABERP → **Auto-árazás** tab.

Within **60s** of submission (the daemon's poll cadence), a new row should appear in **Pricing jobs** with your quote's UUID. Watch its `state` column progress:

```
Fetched → Extracting → Pricing → Rendering → PostingBack → Posted
```

Each transition takes a few seconds for a simple cube; allow up to 30s total for the full pipeline on a cold first run.

**Verify:** the row reaches `Posted` (green chip). The right-side detail pane shows the priced breakdown (lines, totals, currency).

**If the row gets stuck in `Failed`:**

- **`Failed` after `Fetched`:** ABERP couldn't pull the CAD blob from the storefront. Usually a bearer mismatch (`ABERP_SITE_ADMIN_TOKEN` on the storefront vs `quote_intake_token` on ABERP). Fix on the ABERP side: Settings → Quote Intake → re-paste bearer.
- **`Failed` after `Extracting`:** the Python OCCT extractor blew up on your CAD. Switch to a simpler shape (a cube STEP); re-submit a fresh quote (this aborts the current one).
- **`Failed` after `Pricing`:** the Rust engine couldn't price the FeatureGraph against the catalogue. Most common cause is the chosen material grade not being in `quoting_materials`. Confirm in ABERP → Materials that the grade you picked in Step 1 exists.
- **`Failed` after `Rendering`:** PDF generator crashed. Rare; check `tracing` log.
- **`Failed` after `PostingBack`:** the priced-writeback POST to the storefront returned 4xx/5xx. Open the row detail → "Last error" — usually a bearer mismatch (different from above; this is the same `ABERP_SITE_ADMIN_TOKEN` on the OTHER direction). Re-check the storefront's env and `systemctl restart aberp-site`.

Click **Retry** on the row after fixing.

---

### Step 4 — [abenerp.com browser] Refresh the customer status page

**[abenerp.com browser]** Refresh the `/q/<UUID>?t=<token>` tab you kept open from Step 2.

**Verify:** the state chip has flipped from `Received` to `Priced` (HU `Beárazva`). The page now renders:

- The priced lines (machining time, material, finish surcharges).
- The totals (subtotal, VAT, total).
- An accept-link CTA: **"Click to accept this quote."**
- A "Download PDF" link.

**Click "Download PDF"** to confirm the indicative PDF renders. The PDF should show the breakdown including any 5-axis line or thin-wall surcharge line if applicable (addendum 1 — for a cube these will be absent, which is correct).

---

### Step 5 — [Email inbox] Confirm the "your quote is ready" email arrives

**[Email inbox]** Within ~30s after Step 3's `Posted` state, a second email should arrive. Subject: `Ajánlat <UUID-short> — készen áll / Your quote is ready`.

Body:

- 1-2 paragraphs HU+EN.
- A prominent **"Click to accept this quote"** CTA — the HMAC accept link of the form `https://abenerp.com/q/<UUID>/accept?ts=<expiry-ISO>&sig=<HMAC>`.
- The PDF attached as `quote.pdf` (~100 KB for a cube).

**Verify:** the email arrived and the PDF attachment opens.

**If no email arrives within 5 minutes:** see Troubleshooting §"No email arrives" — at this point the relay path has already been validated by Step 2, so the more likely cause is ABERP-side SMTP transient failure or a bad recipient.

---

### Step 6 — [abenerp.com browser] Click the accept link, type ACCEPT

**[abenerp.com browser]** Click the **"Click to accept this quote"** button in the email.

A new tab opens at `/q/<UUID>/accept?ts=…&sig=…`. The page renders:

- The full quote summary (price, valid_until).
- A **stock-alert banner** if `stock_alert=true` was set at pricing time. RED, both HU and EN ("Stock status changed since this quote was issued — pricing may be refreshed if not accepted by <date>."). For a clean in-stock test this banner should be **absent** — its presence is the addendum-2 customer-side enforcement and is exercised in a separate run.
- A large monospaced input below the summary captioned: **"Type ACCEPT to confirm"**.

**Type `ACCEPT`** (exactly, all caps — the comparison is case-sensitive per `[[hulye-biztos]]` parity with the operator DEAL UX).

**Verify:** as you finish typing, the input border turns GREEN and the **Confirm acceptance** button below becomes enabled (it was disabled before the token matched).

**Click "Confirm acceptance."**

**Verify:** the page redirects to `/q/<UUID>?t=<token>` showing state `Elfogadva / Accepted`. Copy reads "Quote approved — we'll be in touch within N business days."

---

### Step 7 — [Email inbox] Confirm the "thank you for accepting" email

**[Email inbox]** Within ~30s, a third email arrives. Subject: HU+EN, "Thank you for accepting your quote."

This is the second relay-path validation (the first was Step 2's submission-received email, the second was Step 5's quote-ready). Three relays through ABERP without dropping is the green-light signal for ADR-0007.

**Verify:** the email is in the inbox; body confirms the acceptance reference.

---

### Step 8 — [ABERP desktop] Confirm the quote shows up in Ajánlatok

**[ABERP desktop]** Switch to ABERP → **Ajánlatok** tab (the standard intake list).

**Verify:** within ~60s (the daemon's next poll cycle — `~5 min default in prod, 60s in local-dev` per S211 daemon cadence), the accepted quote appears in the intake list with state matching the storefront's `approved`.

**Wire validated in S294/PR-08:** the storefront's `GET /api/quotes?status=approved` endpoint now has unit-test coverage proving the exact shape ABERP consumes — `contact.{name,email}`, `request.{material_preference,quantity,deadline}`, `pricing.{valid_until,breakdown_json}`, plus the acceptance audit trio (`accepted_at`, `acceptance_signature_ts`, optional `acceptance_audit_id`). The same PR added an optional `?since=<iso>` cursor so the daemon can poll incrementally (`since=accepted_at >= cursor` when `status=approved`), keeping wire bytes proportional to new approvals rather than the full history. **If the row still does not appear within one poll cycle plus a margin**, jump to Troubleshooting §"Approved row not picked up by ABERP" — the wire is now load-bearing for prod and the failure mode is bearer or env-var, not the contract itself.

---

### Step 9 — [ABERP desktop] Run the DEAL saga

**[ABERP desktop]** In **Ajánlatok**, click the row to open the DEAL section.

If the row carries `stock_alert=true` (it should not, for this walkthrough's in-stock material), type `REFRESH` first (addendum-2 operator-side gate from S272). For a clean run, this gate is dormant.

Then **type the first 8 characters of the intake_ref** (the BIG/RED DEAL token from S272's addendum-3 operator-side enforcement). The field is intentionally oversized and the button intentionally hard-to-miss — `[[hulye-biztos]]` parity.

Click **DEAL**.

**Verify:** the page transitions through the saga's stages (Sales Order created → Work Order created → Material reserved → Audit events written). Final state shows the WO id and the SO id with green chips.

---

### Step 10 — [ABERP desktop] Confirm the four audit events

**[ABERP desktop]** Open ABERP → **Audit ledger** (or whatever tab surfaces `audit_events`). Filter on the quote UUID from Step 1.

You should see **at least four rows** in this order:

1. `quote.deal_issued` — DEAL token confirmed.
2. `quote.sales_order_created` — Sales Order written.
3. `quote.work_order_created` — Work Order written.
4. `inventory.material_committed` — material reservation booked against `quoting_materials.committed_qty`.

You may also see prior `quote.pricing_*` rows from the daemon's pipeline (one per state transition in Step 3). Those confirm the pricing-side observability.

**Verify:** all four `quote.*` and `inventory.*` rows present, with the same `correlation_id` linking them.

---

### Step 11 — [ABERP desktop] Confirm the material commit hit Inventory Balances

**[ABERP desktop]** Open ABERP → **Inventory Balances** tab.

Find the row for the material you picked in Step 1. Compare `committed_qty` to the value before Step 9 (you may need to take a screenshot before running DEAL to compare; on a fresh run this is just confirming it is non-zero and equal to the quantity from Step 1, i.e. `5`).

**Verify:** `committed_qty` has incremented by **5** (the quantity from Step 1) since before Step 9.

---

**Walkthrough complete.** The end-to-end auto-quote pipeline is validated on production.

---

## Troubleshooting

For each predictable failure mode: symptom Ervin sees, WHERE to look first, and the fix.

### Paused daemon (Auto-árazás tab shows daemon dormant)

- **Symptom:** ABERP → Auto-árazás shows RED card "Daemon dormant — Python venv not detected" or "Daemon paused — bearer rejected."
- **WHERE:** ABERP → Auto-árazás top bar, then ABERP → Settings → Quote Intake.
- **Fix (venv missing):** `./run/upgrade_prod.sh PROD_v2.27.2` from the ABERP checkout (auto-provisions the venv, S282).
- **Fix (bearer paused):** Settings → Quote Intake → "Re-paste bearer" → paste from `[[aberp-smtp-spoc]]` keychain entry → click Resume.

### Extractor crash (pricing job stuck at `Failed` after `Extracting`)

- **Symptom:** ABERP → Auto-árazás row reaches `Extracting` then flips RED with `Failed`.
- **WHERE:** click the row → detail pane → "Last error" (the Python stderr is captured there).
- **Fix (STEP file — assembly):** "STEP file contains an assembly with N solids; only single-part STEP is supported in v1" — the OCCT extractor (PROD_v2.27.8 / S292) rejects multi-solid STEP. Re-export from your CAD tool as a single-part STEP, or simplify to an STL.
- **Fix (STEP file — no solid body):** "STEP file contains no solid body" — the file likely contains only surfaces / sheets / wireframes. Re-export with solid bodies, or send an STL.
- **Fix (STEP file — could not be parsed):** "STEP file could not be parsed (OCCT ReadFile status=N)" — file is malformed. Re-export from a known-good tool, or fall back to STL.
- **Fix (unsupported extension):** "Unsupported file extension '.iges'…" — the storefront accepts 11 formats but the extractor only handles `.stl` / `.step` / `.stp`. The `Permanent` badge tells the operator Retry will never help; the customer must re-upload in a supported format.
- **Fix (material grade not in catalogue):** "material grade `X` is not in the catalogue snapshot" — the form's hardcoded dropdown doesn't match ABERP's seeded grades. Re-submit and type one of the eight grades listed in Step 1 (`6061-T6`, `7075-T651`, `304`, `316`, `Ti-6Al-4V`, `Inconel 718`, `PEEK`, `MONEL_650`). For local-dev, also click ABERP → Materials → "Teszt push" once to seed the local catalogue mirror (PROD_v2.27.5 / S289).
- **Fix (margin floor violation):** "computed margin X below configured floor Y" — the engine's MarginFloor rule fired. The Pricing-job badge reads **"Operator review required"** (PROD_v2.27.9 / S297 F6 — distinct from the generic "Operator retry required"). Edit ABERP → Quoting Parameters → Margin profile BEFORE clicking Retry; Retry alone fails identically.
- **Fix (other):** the CAD file is unparseable. Re-submit with a simpler shape (a cube STL). If a previously-working shape now fails, the OCCT extractor regressed — file under `[[aberp-python-auto-discovery]]` follow-up.

### Legacy orphan row from before daemon hardening (c1cf32 perpetually "Sikertelen / Failed")

- **Symptom:** anyone who upgraded from `PROD_v2.27.0` → `PROD_v2.27.4` sees a stuck row in **Auto-árazás** with id `c1cf32ed-72b6-4708-8abb-6359d27f042b` perpetually showing **"Sikertelen / Failed — STEP extraction not yet implemented"**.
- **WHERE:** ABERP → Auto-árazás → the row predates the daemon's retry-policy hardening; the daemon retried the same STEP-extractor stub error 5 times before being calmed in `PROD_v2.27.4`.
- **Fix:** **not a bug — just ignore it.** This is an orphan from before the hardening landed and has no live effect on new submissions.
- **⚠️ After `PROD_v2.27.8` — c1cf32 Retry behavior changed.** S292 / PR-273 shipped the OCCT-backed STEP extractor. If you click **Retry** on the c1cf32 row "just to see":
  1. **Valid single-part STEP, MM units** → the row advances to `Posted`, a priced PDF is rendered, and a "your quote is ready" email is queued to the _original customer_. If that's an old test inbox you don't care about, harmless; if it's a real address, the customer gets an unexpected email about an old quote.
  2. **Assembly / no-solid STEP** → re-fails with classifier-Permanent verdict, badge stays.
  3. **METRE / non-MM units STEP** → `PROD_v2.27.9` (S297 F2) silently converts to mm. Pre-`PROD_v2.27.9` would have produced a near-zero-volume quote.
- **Recommendation:** **prefer the SQL DELETE below over Retry** until you have confirmed (a) the c1cf32 blob is a valid single-part MM-unit STEP AND (b) the original customer email is one you can safely email again.
- **Advanced (operator-only):** delete the row manually from ABERP's DuckDB shell:
  ```sql
  DELETE FROM quote_pricing_jobs WHERE id = 'c1cf32ed-72b6-4708-8abb-6359d27f042b';
  ```
  Do not write a sweep script; the per-row visibility is intentional so the operator notices similar future regressions.

### POST-back 401 (pricing job stuck at `Failed` after `PostingBack`)

- **Symptom:** row reaches `PostingBack` then flips RED.
- **WHERE:** row detail → "Last error" reads `HTTP 401 from storefront`.
- **Fix:** `ABERP_QUOTE_INTAKE_TOKEN` on the ABERP side and `ABERP_SITE_ADMIN_TOKEN` on the storefront side disagree.
  - **[Browser SSH]** `sudo grep ABERP_SITE_ADMIN_TOKEN /etc/aberp-site.env`
  - **[ABERP desktop]** Settings → Quote Intake → re-paste the matching value → click Resume.

### POST-back 503 (ABERP can't reach storefront from Lightsail OR vice versa)

- **Symptom:** any cross-stack call fails with 5xx or network error.
- **WHERE:** row detail → "Last error" or ABERP `tracing` log.
- **Fix:** confirm the storefront's `ABERP_INTERNAL_BASE_URL` resolves from the Lightsail box. **[Browser SSH]** `curl -fsS "$(sudo grep -E '^ABERP_INTERNAL_BASE_URL=' /etc/aberp-site.env | cut -d= -f2-)/api/health"` — should return ABERP's health JSON. If it times out, ABERP is unreachable on the path the storefront is configured to use — this is the open-question prod topology gap (see §"Open questions").

### No email arrives (within 5 min of expected send)

- **Symptom:** Step 2 / Step 5 / Step 7 email never lands in inbox.
- **WHERE first:** ABERP → Audit ledger → filter on `email.relayed_storefront` → there should be one row per expected email with `audit_id`.
  - If the row is **present** but the email never arrived, the failure is downstream on ABERP's SMTP — check `[[aberp-smtp-spoc]]` keychain entry, ABERP's mail log.
  - If the row is **absent**, the storefront never reached the relay. Check **[Browser SSH]** `sudo journalctl -u aberp-site -n 100 | grep -i 'EmailRelayError\|email-relay'` — common kinds are `unconfigured` (env vars missing — see Preflight 3), `unauthorized` (token mismatch), `network` (DNS or TCP to `ABERP_INTERNAL_BASE_URL` fails).
- **Recipient typos:** Step 1's email was malformed. Re-submit a fresh quote.

### Relay queue stuck (storefront keeps retrying 503)

- **Symptom:** journalctl shows repeating `EmailRelayError('unavailable', 503)`.
- **WHERE:** ABERP — likely SMTP daemon down or ABERP's `outbound_email_queue` table backed up. ABERP-side fix; the storefront's retry will resume once ABERP returns 200.

### Approved row not picked up by ABERP (Step 8 hangs)

- **Symptom:** Step 6 confirmed `Elfogadva / Accepted` on the storefront, but Step 8's Ajánlatok tab shows no new row after one full daemon poll cycle (≥ 5 min in prod, ≥ 60s in local-dev).
- **WHERE first:** **[Browser SSH / local terminal]** curl the polling endpoint with the same bearer ABERP uses, and confirm the row is on the wire:

  ```sh
  curl -fsS -H "Authorization: Bearer $(sudo grep '^ABERP_SITE_ADMIN_TOKEN=' /etc/aberp-site.env | cut -d= -f2-)" \
    "$(sudo grep '^ABERP_SITE_PUBLIC_URL=' /etc/aberp-site.env | cut -d= -f2-)/api/quotes?status=approved" \
    | jq '.quotes[] | {id, status, accepted_at, acceptance_signature_ts}'
  ```

  - **Row present in the curl output** → the storefront wire is fine; the gap is ABERP-side. Check ABERP → Settings → Quote Intake → "last cycle" timestamp (is the daemon still firing?) and the bearer (`ABERP_QUOTE_INTAKE_TOKEN`-side / `ABERP_SITE_ADMIN_TOKEN`-side match).
  - **Row absent from the curl output** → storefront did not persist the transition. Look at the storefront's `/data/quotes/<UUID>/metadata.json` on the Lightsail box; `status` should read `"approved"` and `accepted_at` should be an ISO timestamp. If `status` is still `"quoted"`, the accept POST 403'd (see "Accept page 403 from the POST" above) and the customer's "approved" landing page was actually the idempotent replay of an earlier already-approved quote, not a fresh transition.

- **Fix (incremental-poll edge case):** if ABERP started passing `?since=<iso>` after S294/PR-08 and the row's `accepted_at` is older than the cursor, the daemon will not refetch it. This is by design — re-issue the quote or have the operator reset the daemon's last-cursor watermark in ABERP → Settings → Quote Intake.

### HMAC accept link 403 / "expired"

- **Symptom:** Step 6's accept-link click lands on a 403 page reading "this accept link has expired or is invalid."
- **WHERE:** check the `ts=` query param in the URL — it's an ISO timestamp. Compare to today's date.
- **Fix:** if `ts` is in the past, the 30-day window has lapsed. ABERP re-quote (operator action) mints a new quote_id and a fresh link.
- **Fix (if `ts` is in the future but still 403):** signature mismatch — likely `QUOTE_STATUS_SIGNING_KEY` was rotated between issue and click. The key rotation invalidates every link; user needs a fresh quote.

### Accept page 403 from the POST (signature OK on GET but POST fails)

- **Symptom:** Step 6 — the GET landing renders fine but typing ACCEPT and clicking Confirm 403s.
- **WHERE:** **[Browser SSH]** `sudo journalctl -u aberp-site -n 50 | grep accept` — look for an Origin allowlist rejection (`[[quote-csrf-origin]]`).
- **Fix:** the `ORIGIN` env var on the Lightsail box does not match the public domain serving the page. **[Browser SSH]** `sudo grep '^ORIGIN=' /etc/aberp-site.env` — must be `https://abenerp.com` (no trailing slash, no protocol mismatch). Edit, then `sudo systemctl restart aberp-site`.

### DEAL 409 stock_alert_refresh_required

- **Symptom:** Step 9 — clicking DEAL throws "Stock status changed; type REFRESH first."
- **WHERE:** the row's DEAL section above the token field.
- **Fix:** type `REFRESH` (BIG, RED, single-use per addendum 2), then re-type the DEAL token. This re-checks the catalogue stock status; if stable, DEAL proceeds; if still alerted, the operator must re-quote.

---

## What's NOT in this walkthrough (open questions)

The following are real gaps surfaced by writing this walkthrough. None blocks the test path — but each is a follow-up the next session should pick up.

1. **Multi-tenant setup.** Today the storefront serves a single tenant (`abenerp.com`); ABERP runs on one Mac. SaaS migration (`[[aberp-saas-migration]]`) introduces multi-tenant routing — out of scope until that arc starts.

2. **Email-link prefetch.** Some MTAs (Outlook Safe Links, Gmail's mailer-daemon prefetch, corporate proxies) speculatively fetch URLs in email bodies. A GET of `/q/<UUID>/accept?ts=&sig=` from a prefetcher would render the accept page but NOT submit the form — so single-use enforcement holds. **However,** a future change that auto-accepts on landing (or a careless redirect) would be triggered by hover, not click. Mitigations TBD: rel="noreferrer", a typed-token gate (already implemented per Step 6), or a server-side "two-step" pattern.

3. **Storefront → ABERP network topology in prod.** Today's `ABERP_INTERNAL_BASE_URL` likely points to `http://127.0.0.1:8080` (works only in local-dev when both processes share a host) or to a tunnel/VPN URL not yet specified. **Before the first real customer's quote, this topology needs a decision:** public TLS terminus on ABERP (with proper bearer hardening), Cloudflare Tunnel, Tailscale, or the "queue-and-let-ABERP-poll" fallback ADR-0007 §"Reconciliation with ADR-0006" sketched. **S299 will land an ADR comparing these four options.** Once that ADR closes, the "Local-dev test path (achievable today)" section above will be supplemented with a "Prod test path" section that mirrors today's LD-1..LD-5 sequence but against the chosen topology — and the prod-style Preflight 1..5 will be runnable without local-dev workarounds. See `[[email-send-path-pending]]`.

4. ~~**"Submission received" email path — does the storefront send one today?**~~ **Shipped in PR-07 (S293).** `src/lib/server/email.ts` now exports `sendSubmissionReceivedEmail(q)` — a bilingual HU+EN template with the customer's signed status link. `/api/quote` fires it via `setImmediate` after the quote is persisted to disk, so the customer's 200 OK never blocks on the relay round-trip per `[[post-issue-async]]`. Failure paths (missing token, 503) log and swallow; the relay-side audit (`email.relayed_storefront`) is the source of truth ABERP-side. Step 2 above reflects the new shape.

5. ~~**Storefront `quoted → approved` flow into ABERP intake.**~~ **Shipped in S294/PR-08.** `src/routes/api/quotes/+server.ts` now has unit-test coverage proving the response shape ABERP consumes — `contact.{name,email}`, `request.{material_preference,quantity,deadline}`, `pricing.{valid_until,breakdown_json}`, and the acceptance audit trio (`accepted_at`, `acceptance_signature_ts`, optional `acceptance_audit_id`). The accept handler's `quoted → approved` transition (S283, untouched in this PR) lands the row directly in the polling endpoint's result set with all fields populated. PR-08 also added an optional `?since=<iso>` cursor — when `status=approved` it filters on `accepted_at >= since`, otherwise on `received_at >= since` — so the daemon can poll incrementally without re-fetching the full history. **Backlog deferred to next PR (out of scope for PR-08 per S294 brief):** ABERP-side operator-notification polish — when the daemon stages a newly-approved row into `quote_intake_log`, the Ajánlatok tab should surface the storefront `accepted_at` timestamp + a link back to `/q/{id}` for the audit trail. Step 8 of the test path above now treats the wire as load-bearing rather than speculative.

---

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §11 (walkthrough plan that this doc implements).
- ADR-0005 — [HMAC accept link with 30-day expiry](../adr/0005-hmac-accept-link-expiry.md) (accept-link contract).
- ADR-0007 — [Storefront email relay via ABERP](../adr/0007-storefront-email-relay-via-aberp.md) (relay endpoint contract, supersedes ADR-0006).
- `[[walkthrough-format]]` — the schoolboy-with-hands rule.
- `[[aberp-python-auto-discovery]]` — S282 venv auto-provisioning so Preflight 4 just works.
- `[[quote-csrf-origin]]` — the `ORIGIN`-env mismatch that 403s the accept POST.
- `[[email-send-path-pending]]` — the two public-URL env vars still being reconciled.
- `[[local-dev-test-path-gaps]]` — the five operator-discipline gaps the "Local-dev test path" section above documents honestly until S291's `./run/dev-test.sh` lands.
- `[[trust-code-not-operator]]` — the rule each of those five LD-steps violates.
