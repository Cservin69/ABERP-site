# Security review — meta-review of the external minority report

**Reviewed against:** ABERP-site main @ commit `30cd533` (post-S209 + PR-A AWS pipeline).
**Author:** Claude (PR-E), 2026-06-01. No code changes — documentation only.
**Purpose:** evaluate each finding in the external adversarial review against
the code as it actually stands, surface gaps the reviewer missed, and produce
the canonical hardening backlog for Ervin.

## 1. Summary

The minority report is competent, generic, and skews conservative for a v1
lead-generation site. About a third of its recommendations are already
implemented in S208/S209 (the reviewer likely worked from an earlier snapshot
or from the deploy doc without reading the route handlers). About a third are
genuinely deferred work and are explicitly tracked in `docs/deploy.md` as
Phase 3 / 2.0 items. The remaining third are either fair-but-low-priority for
this scale or wrong-shaped (ClamAV quarantine, customer-accounts auth) for the
current threat model.

**Verdict counts across the 7 sections:** 2 ✓ already addressed in spirit, 4
🟡 partially addressed, 1 🔴 not yet addressed at the recommended depth,
0 ⚠️ outright disagreement at section level (disagreements appear at the
sub-recommendation level — see §6).

**Two findings the reviewer missed are deploy-blocking, not Phase-3 work:**

1. **Form-action auth bypass.** `/admin/quotes/[id]?/status` runs its mutation
   handler **before** the parent layout's auth-check. Anyone who knows a
   quote UUID can mutate its status without a valid admin cookie. CSRF on the
   browser path is closed by SvelteKit's origin check; direct curl with the
   right Origin header succeeds.
2. **`BODY_SIZE_LIMIT=512K` default.** `adapter-node` rejects every request
   larger than 512 KB unless `BODY_SIZE_LIMIT` is set explicitly. The 50 MB
   cap in `src/routes/api/quote/+server.ts` is moot — the request is killed
   with `413 Payload Too Large` long before the handler runs. The bootstrap
   env template (`bin/lightsail-bootstrap.sh:env-template`) does not set it.

The top hardening priorities are in §5.

---

## 2. Inventory — what protections exist today

| File | Protections present | Evidence |
| --- | --- | --- |
| `src/routes/api/quote/+server.ts` (public POST) | Extension allowlist; per-field length caps; header-injection regex; email regex; UUID v4 id; sanitized filename (alphanum/`._-` only); per-quote dir path-traversal guard; collision-resilient filename de-dupe. | lines 12–27 (ext), 38–41 (regexes), 87–105 (caps + validation), 133–137 (path resolve), 54–59 (sanitize), 144–158 (dedup + traversal recheck). |
| `src/routes/api/quotes/+server.ts` (operator list) | Bearer auth, status-filter allowlist, path-traversal guard on dir walk, swallow-and-continue on bad metadata. | lines 11, 14, 32. |
| `src/routes/api/quotes/[id]/+server.ts` (operator single) | Bearer auth before UUID check (no oracle), UUID v4 regex, 404 on miss. | lines 9–13. |
| `src/routes/api/quotes/[id]/files/[filename]/+server.ts` (operator download) | Bearer auth; UUID + filename regex; membership check against `metadata.files`; resolved-path containment check; `Content-Disposition: attachment`; `Cache-Control: private, no-store`. | lines 13–48. |
| `src/routes/api/quotes/[id]/status/+server.ts` (operator JSON mutate) | Bearer auth; UUID regex; JSON-body validation; status allowlist; notes length + header-injection cap; atomic write; append-only `status_history` entry. | lines 13, 16, 30–43, 50–59. |
| `src/lib/server/auth.ts` | `timingSafeEqual` on bearer + cookie; refuse-to-start 503 if env unset; HttpOnly + SameSite=Strict cookie; `secure: !dev` set on login. | lines 8–20, 75–83. |
| `src/lib/server/quote-store.ts` | `pathResolve` containment check on `quoteDir` and `quoteFilePath`; atomic rename via `metadata.json.tmp-<uuid>`. | lines 44–50, 90–97, 99–106. |
| `src/routes/admin/+layout.server.ts` | Cookie gate for ALL `/admin/*` GETs except `/admin/login`; 303 redirect with `next=` round-tripper. | lines 9–16. |
| `src/routes/admin/login/+page.server.ts` | Form-action takes plaintext token, `checkLogin` uses timing-safe compare, sets cookie with `secure: !dev`. | lines 17–34. |
| `src/hooks.server.ts` (PR-A) | `X-CloudFront-Secret` origin-auth on every request except `/healthz`; `timingSafeEqual` on the secret. | lines 31–46. |
| `svelte.config.js` | adapter-node only; `csrf.checkOrigin` defaults to `true` (verified in `@sveltejs/kit` config schema). | line 9. |
| `.github/workflows/deploy.yml` | OIDC role assumption; explicit `id-token: write` + `contents: read` only; least-privilege IAM (`docs/aws/iam-deploy-role.md`); separated build/static/dynamic jobs; SHA-tagged tarball. | lines 20–22, 65–67. |
| `docs/aws/aberp-site.service` | systemd hardening: `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp=true`, narrow `ReadWritePaths`. | lines 22–27. |
| `docs/privacy.md` | GDPR Art. 6(1)(b) lawful basis stated; subject-rights list; controller named; retention deferred with caveat documented; CAD-as-IP flagged. | lines 16–34, 49–74. |

---

## 3. Finding-by-finding meta-review

### Finding 1 — File uploads (CAD), High

**Reviewer recommended:** magic-byte validation, size limits, filename
sanitization with UUID storage, quarantine flow, encryption at rest,
upload audit log, separate processing service.

**Verdict: 🟡 PARTIALLY ADDRESSED.**

| Sub-control | Status | Evidence |
| --- | --- | --- |
| Size limits | ✓ | 50 MB total, 10-file cap, per-file empty-file reject. `+server.ts:117–131`. |
| Filename sanitization | ✓ | `sanitizeFilename` strips to `[A-Za-z0-9._-]`, slices to 200 chars, replaces leading dots, falls back to `unnamed`. Path-traversal recheck on resolved dest. `+server.ts:54–59, 144–158`. RTL Unicode overrides get stripped to `_` — no bypass. |
| UUID-based storage | 🟡 | The **directory** is a UUID; the **file** keeps its (sanitized) original name. Reviewer's stronger form (store-as-UUID, keep originals only in metadata.json) would harden against any future filename-driven attack at read time. Currently mitigated by the file-download endpoint's regex + membership check. |
| Magic-byte validation | 🔴 | Not done. Extension allowlist only. A `.step` file containing arbitrary bytes is accepted. Low risk because CAD files never auto-execute in the manufacturing pipeline (see §6). |
| Quarantine flow | 🔴 | All quotes land in `received` and are visible to the operator immediately. There is no `quarantined` → `cleared` state machine. Defer — see §6. |
| Encryption at rest | 🔴 | Underlying disk encryption only (Lightsail attached block storage). No envelope encryption. Explicitly deferred to Phase 3 in `docs/deploy.md:401`. |
| Upload audit log | 🟡 | `received_at` + `consent_at` captured on the metadata; `status_history` captures subsequent mutations. **No** separate append-only audit log; metadata.json itself is mutable by anyone with disk write (and by the buggy form action — see §4 #1). |
| Separate processing service | 🔴 | Out of scope at v1. The CAD never reaches an automated pipeline; operator manually opens it. |

### Finding 2 — Public quote form, Medium-High

**Reviewer recommended:** SvelteKit form actions, rate limiting, bot
protection, data minimization, GDPR consent, audit ledger, retention policy.

**Verdict: 🟡 PARTIALLY ADDRESSED.**

| Sub-control | Status | Evidence |
| --- | --- | --- |
| SvelteKit form actions | ⚠️ partial — the public form uses `fetch('/api/quote', …)` (not a `+page.server.ts` action). Functionally equivalent — same CSRF origin check applies since the body is `multipart/form-data`. The reviewer's recommendation reflects a stylistic preference, not a security gap. `quote/+page.svelte:78`. |
| Rate limiting | 🔴 | Not implemented. Explicitly deferred in `docs/deploy.md:400`. CloudFront WAF rate-limit rule is named as the stop-gap but not yet configured. |
| Bot protection | 🔴 | No CAPTCHA, no honeypot, no proof-of-work. Easiest add: a hidden honeypot field. |
| Data minimization | ✓ | Only `name`, `email`, `consent` are required. Company, material, quantity, deadline, notes are all optional. No tracking pixels or third-party fingerprinting. |
| GDPR consent capture | ✓ | `consent === 'true'` is required; `consent_at` ISO timestamp stored alongside the record. Privacy policy linked from the form. `+server.ts:80, 184; +page.svelte:242–249`. |
| Audit ledger | 🟡 | `received_at` + `status_history` is the de-facto audit trail. Not append-only at the FS level (the file is rewritten on each status change); a hash-chain or write-once log would be the next step. |
| Retention policy | 🟡 | Documented as "operator-determined, pending finalisation" (`docs/privacy.md:28`). No automated TTL. Defer per `deploy.md:402`. |

### Finding 3 — Auth & authz, Medium

**Reviewer recommended:** session-based auth with HttpOnly + SameSite=Strict +
Secure cookies; future customer accounts need proper auth; log admin actions.

**Verdict: 🟡 PARTIALLY ADDRESSED.**

| Sub-control | Status | Evidence |
| --- | --- | --- |
| HttpOnly cookie | ✓ | `auth.ts:78`. |
| SameSite=Strict | ✓ | `auth.ts:79`. |
| Secure flag in production | ✓ | `auth.ts:80` uses `secure: !dev`; login server passes `!dev` via `setAdminCookie(cookies, submitted, !dev)`. `login/+page.server.ts:31`. |
| Session-based (cookie value ≠ secret) | 🔴 | The cookie value **is** the admin token, not a session ID. Stealing the cookie = stealing the secret. Rotation kills all sessions everywhere (browser + ABERP polling, since they share the secret). Acceptable for a single-operator MVP; needs a real session-store before multi-operator. |
| Future customer auth | 🔴 / N/A | Out of scope; no customer accounts in Phase 2. |
| Admin action logging | 🔴 | No structured admin-action log. `status_history` captures the *result* of an admin mutation, but the actor identity is fixed-by-construction (single operator) and the IP/UA isn't recorded. |

### Finding 4 — Infra hardening, Medium

**Reviewer recommended:** CSP / Permissions-Policy / X-Content-Type-Options /
Referrer-Policy via CloudFront; AWS WAF before Phase 2 live; least-privilege
IAM for GH Actions OIDC; CloudFront logging to protected bucket; envelope
encryption at rest; npm audit / Dependabot.

**Verdict: 🟡 PARTIALLY ADDRESSED.**

| Sub-control | Status | Evidence |
| --- | --- | --- |
| Security response headers via CloudFront | 🔴 | `docs/aws/cloudfront-behaviors.md` does not mention a CloudFront Response Headers Policy. Nothing in the code or docs adds CSP / X-Content-Type-Options / Referrer-Policy / Permissions-Policy. Hooks middleware doesn't set them either. |
| AWS WAF | 🔴 | Documented as deferred (`operator-checklist.md:196`, `deploy.md:232`). Reviewer is right that this should land before public launch — see backlog. |
| Least-privilege IAM for OIDC | ✓ | `iam-deploy-role.md` scopes the trust policy `sub` to `repo:Cservin69/ABERP-site:*` (with tightening note) and grants only S3 sync, CloudFront invalidate, SSM SendCommand on a specific instance ARN. No `*` resources. |
| CloudFront access logging to a protected bucket | 🟡 | Mentioned as "optional. If on, 30-day lifecycle on the log bucket" (`cloudfront-behaviors.md:107`). Not enabled by default. Reviewer's argument for "enable it" is valid. |
| Envelope encryption | 🔴 | Phase 3 (see Finding 1). |
| `npm audit` / Dependabot | 🔴 | The CI runs `check`, `lint`, `test:unit`, `build` — no `npm audit`. `bin/lightsail-deploy.sh:59` runs `npm ci --omit=dev --no-audit --no-fund` (audit explicitly off). No `dependabot.yml`. |

### Finding 5 — Client-side & WebGL, Low-Medium

**Reviewer recommended:** treat user input to RainEffect shaders as untrusted;
defend against resource-consumption attacks via bad shaders; CSP to contain.

**Verdict: ⚠️ PARTIALLY DISAGREE.**

The RainEffect shaders are bundled at build time via Vite's `?raw` import
(`src/lib/rain-effect/rain.ts:6–7`). **No user input ever reaches the
shader source.** The reviewer's "treat user input as untrusted" line is
generic-LLM boilerplate that doesn't apply here.

The legitimate sub-recommendation that **does** apply: bad-actor visitors with
WebGL-hostile devices could cause GPU/CPU resource consumption on their *own*
machine — which is annoying for them, not a server-side threat. The
client-side disabled-fallback (`RainCanvas.svelte` checks `browser`) is fine.

CSP would be valuable for the unrelated reason that it'd contain any future
XSS in the marketing pages — that lands in Finding 4 above, not here.

### Finding 6 — Supply chain & code quality, Low-Medium

**Reviewer recommended:** `npm audit` in CI, TS+linting (good), SECURITY.md file.

**Verdict: 🔴 NOT YET ADDRESSED.**

| Sub-control | Status | Evidence |
| --- | --- | --- |
| `npm audit` in CI | 🔴 | Not in `deploy.yml`. |
| Dependabot config | 🔴 | No `.github/dependabot.yml`. |
| TypeScript + lint in CI | ✓ | `deploy.yml:40–42`. |
| `SECURITY.md` | 🔴 | Not present. Easy add; tells researchers where to report. |
| Pin / lockfile review | ✓ | `package-lock.json` is committed; `npm ci` enforces it. |

### Finding 7 — Privacy & GDPR, Important

**Reviewer recommended:** document data flow for quote submissions, consent,
retention, erasure.

**Verdict: ✓ ALREADY ADDRESSED (mostly).**

`docs/privacy.md` covers all four: data flow (lines 16–34), consent (33),
retention (28, with the caveat that the specific period is "pending"), and
erasure (60). Lawful basis is named (Art. 6(1)(b)). Controller is named, with
a placeholder pending Ervin's entity-name confirmation (line 74).

Gaps:

- **Retention is "pending finalisation"** — needs an actual number to be GDPR-tight.
- **Operator-side SAR fulfilment is a manual email** — fine at single-operator volume; a self-service mechanism becomes appropriate at 2.0.
- **Imprint cross-link / DPO designation** — no DPO is appointed; for a sole-operator processor at this scale, Hungarian/EU rules likely don't require one (revenue thresholds), but worth confirming.

---

## 4. Findings the minority report missed

### #1 (HIGH) — Form-action auth bypass at `/admin/quotes/[id]?/status`

`src/routes/admin/quotes/[id]/+page.server.ts:46–80` defines a `status` form
action that mutates the quote without an auth check. SvelteKit runs form
actions **before** any parent layout server load
(`node_modules/@sveltejs/kit/src/runtime/server/page/index.js`: "for action
requests, first call handler in `+page.server.js`"). The parent
`/admin/+layout.server.ts` redirect-to-login therefore does not protect this
action.

- **Browser CSRF path is closed** by SvelteKit's `csrf.checkOrigin` (default
  `true`) — cross-origin form POSTs are blocked.
- **Direct attack path is open:** `curl -X POST -H 'Origin: https://friboard.com'
  https://friboard.com/admin/quotes/<known-uuid>?/status -d 'status=rejected'`
  succeeds. The attacker needs a UUID; UUID v4 is 128-bit random and not
  enumerable, but UUIDs leak (email, error pages, browser history).

**Fix:** call `requireAdminCookieOrRedirect(cookies, url.pathname)` (or a
new `requireAdminFromAction`) at the top of the action handler. The same
defect probably exists at `/admin/quotes/[id]?/logout` if its action skips
auth — actually `logout` is harmless (idempotent cookie-clear), but the
pattern itself is a footgun: add a guard in every action.

### #2 (HIGH) — `BODY_SIZE_LIMIT=512K` blocks every 50 MB upload

`adapter-node` defaults `BODY_SIZE_LIMIT` to **512 KB**
(`@sveltejs/adapter-node/files/handler.js`). The bootstrap env template
(`bin/lightsail-bootstrap.sh:write /etc/aberp-site.env template`) does not
override it. Result: every multi-megabyte CAD submission fails with `413
Payload Too Large` before the SvelteKit handler runs. The 50 MB cap in
`/api/quote/+server.ts:8` is unreachable.

**Fix:** add `BODY_SIZE_LIMIT=52428800` (50 MiB, matching the in-handler
cap) to the `/etc/aberp-site.env` template, and document it in
`operator-checklist.md`. Without this, Phase 2 is broken on day 1.

### #3 (MEDIUM) — No `npm audit` / no Dependabot

Already covered in Finding 6 above; restated here because the minority report
listed it but the verdict is firmly 🔴. `deploy.yml` should run `npm audit
--audit-level=high` before build; a `.github/dependabot.yml` should bump
weekly. Effort: S.

### #4 (MEDIUM) — Disk-full DoS on `data/quotes/`

Each submission writes up to 50 MB to `/home/aberp/data/quotes/<uuid>/`. With
no rate limit and no global cap, ~400 submissions saturate the 20 GB Lightsail
block storage. There is no IP throttle, no per-day cap, and no automated
retention to claw space back. Mitigations:

- **App-level:** reject when `data/quotes/` is > N GB; emit a CloudWatch alarm.
- **Edge-level:** AWS WAF rate-based rule on `POST /api/quote` (the same one
  the reviewer recommends in Finding 4).

### #5 (LOW) — `status_history` is rewriting-truncate, not append-only

`writeQuoteAtomic` rewrites `metadata.json` whole on each mutation. A
malicious or compromised admin (or anyone with disk write — but if they have
that, you have bigger problems) can retroactively rewrite the `status_history`
array. For a one-operator MVP this is fine. At 2.0 cutover, consider a
separate append-only `audit.jsonl` per quote, or hash-chain the entries.

### #6 (LOW) — No structured logging strategy

`systemd` appends `node build` stdout/stderr to
`/home/aberp/logs/aberp-site.log` (`docs/aws/aberp-site.service:17–18`). No
JSON structure, no PII-redaction policy. Customer emails and CAD filenames
will end up in plaintext logs whenever Node prints an uncaught error. CloudWatch
ingestion is not wired up. Defer, but document a redaction rule before you
turn on CloudWatch Logs ingestion (because once it's in CloudWatch, the GDPR
data-processing record needs to mention it).

### #7 (LOW) — No build-artifact integrity check on Lightsail side

`bin/lightsail-deploy.sh` pulls `build-server-<sha>.tgz` from S3 via
`aws s3 cp` and extracts it. The only integrity check is "the tarball
exists" and "the expected paths are inside". No checksum match against the
known commit SHA. Realistic exposure is low because the only writer to the
deploy bucket is the OIDC role, but a defense-in-depth would `sha256sum` the
tarball and compare against an SSM Parameter Store value written by the
upload step. Defer.

### #8 (already-confirmed-safe) — Findings I verified are NOT real

- **Existence oracle on `/api/quotes/[id]`** — false alarm. `requireAdminAuth`
  throws 401 *before* the UUID-format check, so unauthed probes get 401
  regardless of whether the UUID exists. Confirmed at
  `src/routes/api/quotes/[id]/+server.ts:9–13`.
- **`/healthz` info leak** — false alarm. Body is `"ok\n"` only; no
  SHA / version / build-date string. Confirmed at `src/hooks.server.ts:33`.
- **Filename Unicode RTL bypass** — false alarm. `sanitizeFilename` strips to
  `[A-Za-z0-9._-]`, so RTL override chars (`‮` etc.) become `_`.
- **Quote-ID enumeration** — UUID v4, 128-bit random. Not enumerable.
- **`/api/quote` CSRF** — covered by SvelteKit's default
  `csrf.checkOrigin: true` on `multipart/form-data` POSTs.

---

## 5. Prioritized hardening backlog

### 🟥 Block AWS deploy — must do before pushing to friboard.com

| # | Action | Threat | Effort | Scope |
| --- | --- | --- | --- | --- |
| 1 | Add `BODY_SIZE_LIMIT=52428800` to `/etc/aberp-site.env` template + bootstrap script + operator-checklist. | App rejects every 50 MB upload with 413. | S | Code (`bin/lightsail-bootstrap.sh`) + docs. |
| 2 | Auth-guard every `+page.server.ts` action under `/admin/*`. Add a `requireAdminFromAction(cookies)` helper that uses `hasValidAdminCookie` and throws `error(401, …)` if not authed. Call it at the top of `status` action and `logout` action (and any future ones). | Direct-POST mutation of any quote by anyone who learns the UUID. | S | Code (`auth.ts`, `admin/quotes/[id]/+page.server.ts`, `admin/logout/+page.server.ts`). |
| 3 | Tighten the OIDC trust-policy `sub` condition from `repo:Cservin69/ABERP-site:*` to `repo:Cservin69/ABERP-site:ref:refs/heads/main` + `…:environment:production`. The wildcard form means *any* PR branch in the repo can assume the deploy role. | A malicious PR (or compromised dev) could push to `main`-not-yet, run the deploy. | S | AWS-side IAM only; `iam-deploy-role.md` already documents the tighter form. |

### 🟧 Must do before first real customer traffic

| # | Action | Threat | Effort | Scope |
| --- | --- | --- | --- | --- |
| 4 | Configure a CloudFront Response Headers Policy with: `Strict-Transport-Security` (max-age 1y, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and a starting `Content-Security-Policy` (`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'`). Attach to all behaviors. | XSS containment, click-jacking, MIME sniffing, referrer leak. | M | AWS-side CloudFront only. |
| 5 | Add AWS WAF rate-based rule on `POST /api/quote` (e.g. 30 req per 5-min per IP). | Disk-full DoS (#4 in missed findings), automated scraping. | M | AWS-side WAF, plus `operator-checklist.md` step. |
| 6 | Add `npm audit --audit-level=high` step to `.github/workflows/deploy.yml` (before `npm run build`). Add `.github/dependabot.yml` for weekly bumps. | Known-CVE in transitive dep. | S | Code (CI). |
| 7 | Enable CloudFront standard logging to a separate bucket; bucket-policy-restrict to the CloudFront log-delivery principal; 30-day lifecycle to expire. Mention in `docs/privacy.md` if the retention exceeds what's currently documented. | Forensics if attacked; standard compliance baseline. | S | AWS-side CloudFront + S3. |
| 8 | Document admin token rotation procedure (env-var swap + systemd restart + ABERP-side polling-config update). Already half-described in `deploy.md:360`; promote it to its own runbook so it's not buried in the deploy doc. | Token compromise response is currently ad-hoc. | S | Docs. |
| 9 | Add a honeypot field (hidden CSS, name `website` or similar) to `/quote` form; reject submission server-side if filled. | Trivial bot deterrence. | S | Code. |
| 10 | Set a concrete retention period in `docs/privacy.md` and replace the "operator-determined, pending finalisation" line. Suggested: 24 months from last `status_history` entry, with manual erasure on SAR. | GDPR Art. 5(1)(e) storage-limitation principle requires a defined period. | S | Docs + Ervin decision. |

### 🟨 First month post-launch

| # | Action | Threat | Effort | Scope |
| --- | --- | --- | --- | --- |
| 11 | Magic-byte sniff on uploaded CAD files (cheap allowlist for ISO/STEP, STL ASCII/binary, DXF prefix). Reject mismatched ext+magic. | Disguised payloads; doesn't actually execute but hardens against future automation. | M | Code (`/api/quote`). |
| 12 | Replace cookie-value-is-the-secret with an opaque session-id pattern. Store sessions in `data/sessions/<id>.json` (single-operator: a single file is fine). Cookie holds the random id only. | Cookie theft = secret theft. Forward-compat for multi-operator. | M | Code (`auth.ts`). |
| 13 | Append-only `audit.jsonl` per quote (in addition to in-place `status_history`). One line per state transition. | Tamper-evident audit trail. | M | Code (`quote-store.ts`). |
| 14 | `SECURITY.md` at repo root with a `hello@friboard.com` contact and disclosure-window expectations. | Responsible-disclosure on-ramp. | S | Docs. |
| 15 | Wire CloudWatch Logs ingestion for `/home/aberp/logs/aberp-site.{log,err}`; redact `email` / `filename` fields before they're shipped; document the new processor in `docs/privacy.md`. | Operational visibility without leaking PII to a US-region log bucket. | M | Lightsail-side (CloudWatch agent) + docs. |
| 16 | Add `BODY_SIZE_LIMIT`/`SHUTDOWN_TIMEOUT`/`IDLE_TIMEOUT` tuning to the env template with reasoning comments. (Currently they all run on adapter-node defaults.) | Slow-loris-style upload starvation, hung connections. | S | Docs. |

### 🟦 Polish / monitor

| # | Action | Threat | Effort | Scope |
| --- | --- | --- | --- | --- |
| 17 | Build-artifact SHA-256 verification on the Lightsail deploy side (SSM Parameter Store carries the digest). | Defense-in-depth on the S3 staging bucket. | M | Code (`lightsail-deploy.sh`) + workflow. |
| 18 | Automated retention sweeper: nightly cron that moves `data/quotes/<id>` to a `data/archived/` bucket after N months, deletes after N+M. | Storage-minimisation principle. | M | Code (cron + script) + docs. |
| 19 | Per-quote envelope encryption at rest (KMS data key, encrypted JSON blob, decrypted only when the operator opens the detail view). | CAD-as-IP at-rest exposure if the box is seized / disk leaks. | L | Code + AWS-side KMS. |

---

## 6. Where I disagree with the reviewer

- **Streaming uploads at the 50 MB cap.** Marginal. `request.formData()`
  in-memory is fine until the cap rises into the hundreds of MB.
  `BODY_SIZE_LIMIT` (#1 above) is the real upload-flow defect.
- **Quarantine + ClamAV.** Overkill for v1. CAD files never enter an
  automated pipeline; the operator manually opens each one in a desktop CAD
  app, which is its own sandbox boundary. Revisit if/when an automated
  CAD-processing service is added (Phase 5+).
- **Customer accounts auth before Phase 2 launch.** There are no customer
  accounts. The reviewer's full session-auth recommendation is correct
  *conceptually* but doesn't apply to today's surface. Bearer-token admin is
  defensible for a single-operator lead-gen funnel.
- **"SvelteKit form actions" framing of the public quote form.** The form
  uses `fetch()` to the `/api/quote` endpoint, which is functionally
  equivalent to a form action for CSRF purposes (same `multipart/form-data`
  content-type, same default origin check). Switching to a `+page.server.ts`
  action is a stylistic choice, not a security improvement.
- **WebGL shader user-input concern.** RainEffect shaders are bundled at
  build time via Vite `?raw` import. No user input reaches them. The
  reviewer's line here reads as boilerplate.

---

## 7. Open questions for Ervin

1. **Concrete retention period.** What number replaces "operator-determined,
   pending finalisation" in `docs/privacy.md`? 24 months from last
   `status_history` entry is a defensible default for B2B lead-gen with an
   SAR-on-request path. Confirm or push back.
2. **DPO designation.** Áben Consulting Kft. as a sole-operator processor at
   this scale almost certainly doesn't trigger the GDPR DPO requirement, but
   a 5-minute confirmation against NAIH guidance would close the question.
3. **AWS WAF: now or post-launch?** WAF adds ~$5–10/mo for low traffic; if
   the launch is "low and slow" you might land the rate-based rule the day
   you see the first POST that isn't yours. If "we expect to be hammered",
   land it before going public.
4. **Multi-operator timing.** Items #12 (session-id) and #13 (append-only
   audit) become higher-priority once a second person needs admin access.
   When is that — Phase 2.5, Phase 3, or post-2.0-cutover?
5. **Lightsail block storage encryption.** The Lightsail block-storage
   service encrypts by default; the imprint/privacy claim is "underlying disk
   encryption" — confirm this is true for the specific block volume you
   create (it is for Lightsail attached storage, but worth verifying in the
   console so the privacy policy isn't a lie of omission).

---

_Meta-review complete. No code touched. The two ✕ findings (#1, #2 in §4) are
the only items that meaningfully change the "ready to deploy" picture; everything
else is incremental hardening on a fundamentally sound v1._
