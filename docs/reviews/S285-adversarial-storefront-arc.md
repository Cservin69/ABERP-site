# S285 — Adversarial review of the storefront-side auto-quote arc (S276–S284)

**Scope:** PR-01 (S276 design + ADR-0002..0006), PR-02 (S277 catalogue), PR-03 (S278 priced writeback), PR-04-doc (S280 ADR-0007), PR-04 (S283 HMAC accept + relay), PR-05 (S284 walkthrough).
**Style:** doc-only review per `[[parallel-doc-sessions]]`. NO code changes — a sweep PR follows.
**Baseline gates:** vitest 224/224, 16 spec files (PR-02..PR-04 ship the bulk of the new tests). Playwright reports "No tests found." No E2E coverage exists.
**Disposition:** pushback-as-method per `[[pushback-as-method]]`. Where the design is structurally wrong I say so; where the walkthrough sets Ervin up for a confusing failure I name the trap.

---

## Executive summary

**🔴 5 critical · 🟡 11 medium · 🟢 6 confirmed-good**

The arc landed the contracts cleanly and the security primitives (HMAC domain separation, atomic writes, opaque breakdown, multipart wire shape) are sound. But **the pipeline does not actually run end-to-end as the walkthrough describes** — three independent silent failures stack between the storefront and the customer.

Top three blockers Ervin will hit on the very first walkthrough run:

1. **F1 🔴 BODY_SIZE_LIMIT default 512 KB rejects every priced PDF writeback** —
   `npm test`'s tail logs `[aberp-site] BODY_SIZE_LIMIT=(unset, adapter-node default 524288) < 52428800`. The priced-writeback caps the PDF at 5 MB; the adapter-node body cap is **half a MB**. ABERP's daemon will retry forever with `413 Payload Too Large` on the very first PDF that exceeds 512 KB (i.e. all of them). Walkthrough Step 3 will stay in `Failed after PostingBack` and the customer-status page never advances. `src/routes/api/quotes/[id]/priced/+server.ts:21-25`, baseline log.

2. **F2 🔴 60-second per-recipient cooldown silently swallows the priced-ready email on a fast pipeline** —
   `email.ts:67` sets `RECIPIENT_COOLDOWN_MS = 60_000`. Step 1's submission-received email reserves `customer@x` at T+0. Walkthrough Step 5 promises "within ~30s after Step 3's Posted state, a second email should arrive" — within the cooldown window. `sendPricedReadyEmail` returns `{status: 'skipped', reason: 'rate-limited'}` and the priced-writeback handler only logs on `r.status === 'failed'` (`priced/+server.ts:227-229`). No mail, no log, no audit trail. Customer never receives the accept link.

3. **F3 🔴 Status writeback bypasses every state-machine invariant the design pins on it** —
   `api/quotes/[id]/status/+server.ts:30-60` accepts any value from `QUOTE_STATUSES` and overwrites verbatim — no `from→to` validation. Design doc §5 invariant 2 explicitly says "`approved` is only reachable from `quoted`, and only via a valid HMAC token. The Bearer-authenticated path **cannot set `approved`**." Currently violated. A buggy or compromised ABERP-side bearer can move a quote `received → approved` directly, defeating the typed-ACCEPT theater wholesale. This is the single biggest correctness gap in the arc.

Two more critical:

4. **F4 🔴 Submission-received email lacks the status link** — `buildCustomerEmail` (`email.ts:164-186`) never calls `buildQuoteStatusUrl`. Walkthrough Step 2 promises "the body contains a 'view your quote status' link"; the code emits a body that names only the reference UUID. The customer has no way back to the status page until they receive the priced-ready email — which per F2 may never arrive. Matches the standing `[[email-send-path-pending]]` memory.

5. **F5 🔴 Status page does not render an accept-link CTA** — `q/[id]/+page.svelte:93-105` shows only the PDF link in the `pricing` block. The accept link lives **only** in the priced-ready email; lose that email (F2) and the customer cannot accept the quote at all, even though they have a working status link. Design doc §3 Step 4 explicitly names the page should carry "a 'pricing pending' → 'priced — open accept link' indicator"; walkthrough Step 4 lists "An accept-link CTA: 'Click to accept this quote.'" as a verify step.

---

## 1. End-to-end pipeline coherence

### F1 🔴 BODY_SIZE_LIMIT default 512 KB rejects every priced PDF writeback

- **Evidence:** baseline `npm test` tail: `BODY_SIZE_LIMIT=(unset, adapter-node default 524288) < 52428800. CAD uploads larger than this will 413 before the /api/quote handler runs.` The same gate sits in front of `POST /api/quotes/[id]/priced` (`PDF_MAX_BYTES = 5 * 1024 * 1024` at `priced/+server.ts:21`). Adapter-node enforces its own cap before the handler ever runs.
- **Why it's the #1 blocker:** ABERP's priced-writeback POST carries a PDF (~100KB for a cube, larger for real geometry). Anything over 512 KB → adapter returns 413; ABERP retries forever; quote stuck in `quoting`. The walkthrough's existing warning about `/api/quote` CAD uploads is the same root cause but the priced-writeback inherits the same default and was not exercised in a real-PDF test.
- **Recommended fix:** set `BODY_SIZE_LIMIT=52428800` (50 MB, matching `/api/quote`) in the systemd unit `Environment=` block, not in `/etc/aberp-site.env` — operator discipline (`[[trust-code-not-operator]]`). Better: read from a constant in `svelte.config.js` / boot, refuse-to-start if unset, like `getSigningKey()` does.
- **Target session:** S289 sweep (one-line systemd change + a vitest that asserts the bake-in via `process.env.BODY_SIZE_LIMIT`).

### F4 🔴 Submission-received email lacks the status link

- **Evidence:** `email.ts:164-186` `buildCustomerEmail` body lists only `q.id` as the reference. `buildQuoteStatusUrl` exists at `email.ts:420` and is exercised in `email.spec.ts:38,46` but is never called from any send-side builder. Walkthrough Step 2 "the body contains a 'view your quote status' link of the form `https://abenerp.com/q/<UUID>?t=<status-token>`" is fiction relative to the shipped code.
- **Implication:** customer holds a UUID with no URL. Status link only arrives if the priced-ready email arrives, which per F2 may not.
- **Fix:** add `buildQuoteStatusUrl(q.id)` into the body+html arrays in `buildCustomerEmail`. Bake it in tests as a regression gate.
- **Target session:** S289 sweep.

### F5 🔴 Status page does not render an accept-link CTA

- **Evidence:** `q/[id]/+page.svelte:93-105` `priced` block emits only the PDF link. Accept URL is built once at email-send time (`email.ts:341`) and not persisted on the quote — the page would need to either re-derive it (would have to mint a fresh expiry, which violates ADR-0005's "30 days from issue") or persist it.
- **Implication:** if the priced-ready email is lost, the customer has a status link, can see the PDF, but cannot click "Accept." The bridge from `quoted` to `approved` has exactly one customer-facing path and the storefront does not own it durably.
- **Fix:** persist `accept_url` (or just `accept_expiry_ts`) on the quote at priced-writeback time, then render the CTA from persisted state on the status page. Honor the original 30-day window — don't refresh it on each page load.
- **Target session:** S289 sweep (with a small migration: existing `quoted` quotes without the field show a "click the link in your email" hint).

### F11 🟡 writePricedPdfAtomic does not mkdir; missing dir → 500 retry-loop

- **Evidence:** `quote-store.ts:161-169`. `writeFile(tmp, bytes)` will fail if the quote dir was removed (e.g. operator cleanup, walkthrough §"Reversibility" `rm -rf /data/quotes/<UUID>`). The priced-writeback handler `priced/+server.ts:189` doesn't catch — SvelteKit returns 500 — ABERP retries forever.
- **Fix:** either `mkdir({recursive: true})` before write, or 404 the priced-writeback gracefully when the quote dir disappeared (the metadata.json read at `priced/+server.ts:159` already 404s; same posture should apply to the PDF write).
- **Target session:** S289 sweep.

---

## 2. EVE addenda enforcement (storefront echoes)

### F9 🟡 Stock-alert banner is yellow, not the "BIG/RED" the addenda mandate

- **Evidence:** addendum 2 (parent doc `[[aberp-quoting-design-addenda]]`) pins "BIG/RED" prominence as the customer-side echo. Both surfaces use gold/yellow:
  - `q/[id]/+page.svelte:357-374` — `border: rgba(232, 188, 90, 0.55)`, `color: #f0d480` (gold).
  - `q/[id]/accept/+page.svelte:274-282` — same palette.
- The page-level border + alert role land the "BIG"; the color does not land the "RED" the addendum is explicit about.
- **Why it matters:** the addendum's intent is to make a price-revision risk visually distinct from a stable quote. Yellow on dark amber-gold theme blends with the rest of the surface. A customer skimming on a phone will not register it as different from the normal pricing block.
- **Fix:** swap palette to the same `#c66a6a` family already used by `.big-input.mismatch` on the accept page — that _is_ the storefront's red. Don't introduce a new color, harmonize with what's already there.
- **Target session:** S289 sweep (~10 lines of CSS).

### F12 🟡 Addendum 3 (typed ACCEPT) is honored at the UI layer; server gate also exists

- **Confirmed-good:** `q/[id]/accept/+page.server.ts:131-138` re-checks the typed token server-side, rejecting POST when `typed !== ACCEPT_TOKEN`. Client-side gate (button `disabled={!matched}`) is the affordance, not the security boundary. ✅

### F-cross 🟢 Addendum 1 (`requires_5_axis`, `thin_wall_present`)

- Confirmed correctly treated as opaque per ADR-0002 — the storefront persists `breakdown_json` verbatim (`quote-store.ts:34`), never inspects keys, never gates UX on them. ✅

---

## 3. HMAC + token security

### F-good 🟢 HMAC implementation is sound

`quote-token.ts:38-114` — domain separation via literal `"status"` / `"accept"` strings in HMAC input; `timingSafeEqual` on equal-length buffers; explicit length gate before compare; verify-sig-before-expiry order matches ADR-0005 §"Verification order." The dual-acceptance legacy path for PR-L tokens (line 78-83) runs both HMAC computations to completion to defeat a timing oracle on which arm matched. Specs in `quote-token.spec.ts:31-164` cover sig tampering, expiry tampering, domain confusion, and refuse-to-serve. ✅

### F7 🟡 HMAC signing key has no minimum-entropy check

- **Evidence:** `quote-token.ts:30-36` only refuses `length === 0`. A 1-char key passes.
- **Why it matters:** `[[trust-code-not-operator]]`. The signing key is the kill switch and the only thing protecting accept-link forgery. Operator setting `QUOTE_STATUS_SIGNING_KEY=x` should not get a green light.
- **Fix:** require ≥ 32 bytes (`Buffer.from(key, 'utf8').length >= 32`). Refuse-to-serve otherwise. Document in `/etc/aberp-site.env` template.
- **Target session:** S289 sweep.

### F10 🟡 Email-link prefetch leaks customer PII on accept-page GET

- **Evidence:** `q/[id]/accept/+page.server.ts:84-115` renders customer name, email, valid_until, and stock_alert flag with **no typed gate** — the typed-ACCEPT gate only protects the POST. An MTA prefetcher (Outlook Safe Links, Gmail Mailer-Daemon, corporate proxies) speculatively GETs the URL and the response includes the customer's PII in plain HTML.
- The accept POST is correctly protected (the typed-ACCEPT cannot be auto-submitted by a prefetcher). The leak is **information** not **commitment**.
- **Walkthrough §"Open questions" #2 names this** but does not mitigate it.
- **Fixes (composable, pick at least one):**
  - Add `cache-control: private, no-store` header on the accept-page response so intermediaries don't cache.
  - Add `<meta name="robots" content="noindex,noarchive,nocache">` — done for `noindex,nofollow` (line 25) but not `noarchive`/`nocache`.
  - Stronger: gate the GET on a separate one-time "armed" cookie issued by an earlier landing screen (two-screen pattern). Heavier; reserve for a SaaS-migration upgrade.
- **Target session:** S289 sweep for the headers; defer two-screen pattern.

---

## 4. Storefront persistence layer

### F-good 🟢 Atomic writes consistent everywhere

`quote-store.ts:127-133`, `quote-store.ts:161-169`, `catalogue-store.ts:143-149`. tmpfile + rename pattern, random UUID suffix per tmp, parent dir not racy. ✅

### F-good 🟢 Path-traversal protection

`quote-store.ts:81-87` and `:136-143` use `pathResolve` + `startsWith(root + '/')` check. Filename sanitization (`api/quote/+server.ts:62-67`) is `[^A-Za-z0-9._-]` allowlist + leading-dot strip + 200-char cap + de-dup on collision. ✅

### F-good 🟢 Storefront treats `breakdown_json` as opaque

`quote-store.ts:33-34` types it as `Record<string, unknown>`; the priced-writeback handler validates only "is a JSON object" (`priced/+server.ts:47-49`). No inspection, no gating, no drift surface. ✅

### F2 🔴 60s per-recipient cooldown silently drops the priced-ready email

- See Executive Summary above.
- **Root cause:** `RECIPIENT_COOLDOWN_MS = 60_000` (`email.ts:67`) was sized for "stop a flood of submissions from turning into a flood of relay calls" but is applied to a single recipient _across message types_. The submission-received and priced-ready emails are not duplicates; both should land.
- **Fix options:**
  - **(simple)** Track cooldown per (recipient, message-kind) tuple instead of recipient alone.
  - **(simpler)** Drop the per-recipient cooldown entirely; the global ceiling (30/min) is the real protection. The cooldown was anti-flood for the submission path only and that path has its own rate-limit-then-403 in `api/quote/+server.ts` upstream.
  - **(belt-and-braces)** Log on `r.reason === 'rate-limited'` from the priced-writeback handler so a silent drop becomes a noisy one. The current code only logs `r.status === 'failed'`.
- **Target session:** S289 sweep.

### F13 🟡 metadata.json double-write on submission

- **Evidence:** `api/quote/+server.ts:233-244` writes metadata once before notifications, then writes again after if any send "sent." This is a tiny race window: two concurrent submissions never share a quote dir (UUID generation per request), so the race isn't real — but the second write is non-atomic (`writeFile(metadataPath, ...)` directly, not `writeQuoteAtomic`).
- **Fix:** use `writeQuoteAtomic` for the second write too. Trivial.
- **Target session:** S289 sweep.

---

## 5. Email relay client failure modes

### F-good 🟢 Error taxonomy is honest and tested

`email-relay.ts:41-49` distinguishes 8 kinds; specs (`email-relay.spec.ts:85-134`) cover every HTTP code we care about + network failure + malformed-response. Caller in `email.ts:254-265` swallows `EmailRelayError` and logs by kind. ✅

### F8 🟡 Unconfigured relay is silent (`[[trust-code-not-operator]]` violation)

- **Evidence:** `email-relay.ts:67-71` and `email.ts:43-53` both return `null` / `'unconfigured'` on missing env. `sendPricedReadyEmail` returns `{status:'skipped', reason:'unconfigured'}`. Priced-writeback handler logs only `r.status === 'failed'` (`priced/+server.ts:227-229`). Submission notifications likewise (`api/quote/+server.ts:241` only persists `notified_at` on `'sent'`, no log on `'skipped'`).
- **Implication:** operator forgets `ABERP_INTERNAL_BASE_URL` or `ABERP_EMAIL_RELAY_TOKEN`, storefront boots green, every customer email is silently dropped. Discovered only when a customer complains.
- **Per `[[trust-code-not-operator]]`:** refuse-to-start (analogous to `quote-token.ts:33`) when either env var is unset. Or at minimum, emit a startup-time `console.error` so journalctl shows the gap.
- **Fix:** add startup boot check (`hooks.server.ts` is the natural surface). Refuse-to-start if relay envs absent — the storefront's job is to relay through ABERP per ADR-0007, and a storefront that can't send mail is broken regardless of how green it appears.
- **Target session:** S289 sweep.

### F14 🟡 Failed relay calls consume the rate-limit slot

- **Evidence:** `email.ts:89-97`. `tryReserve` pushes onto `globalSends[]` _before_ the fetch; a relay throw does not rewind. A flaky relay (503 storm) burns 30 slots in <60s and then **all** subsequent sends are rate-limited for the remainder of the window — even non-flake recipients.
- **Why it matters:** the 30/min global ceiling is a defensive secondary per ADR-0007 ("the authoritative rate-limit moves to ABERP"). When the storefront's secondary trips, it locks out legitimate sends until the window prunes.
- **Fix:** reserve-then-release pattern: pop the slot from `globalSends` on send failure. Same for `recipientLastSend`.
- **Target session:** S289 sweep.

### F-good 🟢 Token isolation between intake and relay paths

`ABERP_EMAIL_RELAY_TOKEN` distinct from `ABERP_QUOTE_INTAKE_TOKEN` per ADR-0007 §"Auth" — confirmed: `email-relay.ts:93` reads `ABERP_EMAIL_RELAY_TOKEN`, `auth.ts` (Bearer for `/api/quotes*`) reads `ABERP_SITE_ADMIN_TOKEN`. Two surfaces, two tokens, independent rotation. ✅

### F15 🟡 25 MB relay-side cap is unenforced storefront-side

- **Evidence:** ADR-0007 open question #3 suggests 25 MB total request, 20 MB per attachment. The storefront's only check on attachment size is the priced-PDF cap (`priced/+server.ts:21`, 5 MB). The submission-received and operator-notify emails don't attach files; the priced-ready email attaches one PDF. The total stays comfortable today.
- **Fix:** add a defensive cap in `email-relay.ts` (sum of attachment data_b64 lengths × 6/8 ≤ 25 MB before fetch) so a future change that attaches the full CAD or a 3D-preview-laden PDF surfaces locally instead of as `too_large` from ABERP.
- **Target session:** defer to PR-06 unless a real surface needs it.

### F16 🟡 Accept-confirmation email failure is logged but not retried

- **Evidence:** `q/[id]/accept/+page.server.ts:161-189`. If relay 503s on the accept POST, the state still flips to `approved`, `acceptance_audit_id` is undefined, and there is no retry queue. Customer sees the green "Accepted" UI but never gets the thank-you email.
- **Walkthrough Step 7** says "Within ~30s, a third email arrives." If it doesn't, the walkthrough's only mitigation is "check the audit ledger on ABERP" — which won't have a row because the relay never delivered.
- **Fix:** ADR-0007 §"Negative" already named this — persist the email request to a queue file, surface a `Sending` state on next status-page load. Not in PR-04 scope; backlog as PR-06.
- **Target session:** PR-06.

---

## 6. Walkthrough usability

### F17 🔴 Walkthrough Step 2 promises a "view your quote status" link the code doesn't emit

- **Evidence:** walkthrough `end-to-end-auto-quote-test.md:148-149` says "The body contains a 'view your quote status' link of the form `https://abenerp.com/q/<UUID>?t=<status-token>`." `email.ts:164-186` `buildCustomerEmail` body does not include such a link.
- See F4. The walkthrough doc and the implementation disagree. Either fix the code (preferred) or fix the doc; my recommendation is the code fix.

### F18 🔴 Walkthrough Step 4 promises a "Click to accept this quote" CTA the status page doesn't render

- **Evidence:** walkthrough Step 4 lists CTAs that the customer should see; `q/[id]/+page.svelte:93-105` shows only the PDF link.
- See F5. Same fix-the-code recommendation.

### F19 🟡 Preflight 3 carries operator-discipline residue

- **Evidence:** walkthrough Preflight 3 makes the operator run `sudo grep -E '^ABERP_(INTERNAL_BASE_URL|EMAIL_RELAY_TOKEN)=' /etc/aberp-site.env` and hand-edit the file if either is missing. Per `[[trust-code-not-operator]]`, this is exactly what the storefront should refuse-to-start on (see F8).
- The walkthrough is **honest** about the gap (it tells Ervin what to fix), but it documents the workaround instead of the fix. Once F8 lands, Preflight 3 becomes a simple "the systemd unit refuses to start without these set" sentence.
- **Target session:** walkthrough update follows the F8 fix in S289.

### F20 🟡 Preflight 3 conflates dev-loopback with production deploy

- **Evidence:** the same Preflight 3 documents `ABERP_INTERNAL_BASE_URL=http://127.0.0.1:8080` as a "local-dev variant" and flags the prod topology as TBD. Today's prod storefront on Lightsail cannot reach Ervin's Mac on `127.0.0.1`.
- **This is the single biggest production-readiness blocker** (see §10). Walkthrough Step 2 says "this validates the relay path" but the only path it validates is loopback. Ervin runs the walkthrough on his Mac, the relay works, the prod Lightsail deploy still cannot reach the relay endpoint.
- The walkthrough explicitly disclaims this in §"Open questions" #3. The disclaimer is correct; the walkthrough is honest about it. But the title "End-to-end auto-quote test" overpromises: the test path documented is local-dev, not prod E2E.
- **Fix:** rename to `end-to-end-auto-quote-test-local-dev.md` until prod topology is resolved, OR split into a separate "production smoke" walkthrough that runs only on Lightsail and validates the cross-host relay path.
- **Target session:** walkthrough split tracked under `[[email-send-path-pending]]`.

### F21 🟡 Walkthrough Step 8 names the most-likely break but does not fix it

- **Evidence:** `end-to-end-auto-quote-test.md:248-250` flags that ABERP's intake daemon may poll `status=accepted` rather than `status=approved` and the storefront's `approved` writeback may not surface. The walkthrough surfaces this as a backlog item ("file as PR-06 if Step 8 fails"). That is honest framing but it means the walkthrough's title-line claim ("after this walkthrough completes, the pipeline is validated end-to-end on production") is provisional.
- **Recommendation:** before next walkthrough run, confirm on ABERP side that the polling daemon's `?status=` filter matches the storefront's `approved` (not the legacy `accepted`). One-line check on ABERP-side code.

---

## 7. Test coverage gaps

### F22 🟡 No E2E coverage — Playwright reports "No tests found"

- **Evidence:** baseline log `Error: No tests found`. The 224 vitest tests are unit + handler-level; no test drives the full pipeline (catalogue PUT → quote submit → priced writeback → status page → accept link → typed ACCEPT → accept POST).
- The end-to-end walkthrough doc IS the test plan — but it's manual, requires ABERP running, and per F19/F20 requires operator discipline to even reach the relay endpoint.
- **Fix:** Playwright E2E that mocks the ABERP-side relay (or runs against a stub server) and exercises every state transition. Two specs would cover most of the arc:
  - `e2e/quote-full-pipeline.spec.ts` — happy path.
  - `e2e/quote-rate-limit-and-failure.spec.ts` — relay 503, expired accept link, double-accept, stock-alert banner.
- **Target session:** PR-06 (own session, code-touching, sequential per `[[sequential-sessions]]`).

### F23 🟡 No test verifies submission email contains status link

- **Evidence:** `email.test.ts:169-183` `buildCustomerEmail` tests check greeting + reference UUID. Neither verifies `buildQuoteStatusUrl(q.id)` is in the body. The absence allowed F4 to land undetected.
- **Fix:** add a single assertion after F4's fix: `expect(msg.text).toContain(buildQuoteStatusUrl(q.id))`. Regression gate.

### F24 🟡 Priced-writeback tests don't exercise an over-cap payload at the adapter layer

- **Evidence:** `priced.spec.ts` tests `PDF_MAX_BYTES` at the handler level (5 MB → 413), but not at the adapter-node level (512 KB default). The adapter-node cap fires before SvelteKit invokes the handler — so a unit test that calls the handler directly bypasses the very cap that breaks production (F1).
- **Fix:** a Playwright (or supertest-style) test that hits the actual served port with a >512KB PDF and asserts 200 — that would have caught F1. Lands with F22.

### F-good 🟢 Token specs are thorough

`quote-token.spec.ts:31-164` covers sig tampering, expiry tampering, domain confusion (status↔accept), legacy-acceptance window, refuse-to-serve, deterministic signing. ✅

### F-good 🟢 Email-relay specs cover every status code path

`email-relay.spec.ts:33-148`. ✅

---

## 8. SPA dark theme compliance

The storefront is not bound by ABERP's `[[spa-dark-theme-default]]` — it has its own palette. Both the status page and accept page use a coherent dark theme (`#0f1320` background, `#f3eee5` text, `#d4a574` accent, `#c66a6a` red, `#78b878` green).

### F25 🟢 Theme coherence

Dark backgrounds, system fonts, consistent type scale across `/q/{id}` and `/q/{id}/accept`. The accept page's RED-empty / GREEN-matched border on the typed-ACCEPT input is striking and on-brand.

### F9 (cross-ref) 🟡 The one inconsistency: stock-alert banner is gold, not red

See §2 above. The page already ships a perfect red (`#c66a6a` on `.big-input.empty/mismatch`); the stock-alert banner should reuse it.

---

## 9. Operator safety (`[[trust-code-not-operator]]`)

### F26 🔴 The status writeback's missing state-machine check (F3) is the single biggest operator-safety hole in the arc

- The customer-facing surface enforces typed-ACCEPT. The Bearer-facing surface enforces nothing on transitions.
- ADR-0004 §"`quoting` intermediate state" says: "The state machine permits `received → quoting → quoted` and idempotent `quoting → quoting` (re-pull on retry, no-op). A `quoting → received` regression is rejected with 409."
- None of those rules exist in `api/quotes/[id]/status/+server.ts:30-60`. ANY value from `QUOTE_STATUSES` is accepted.
- **Fix:** port the priced-writeback's state-machine checks (`priced/+server.ts:164-186`) to the status handler. Specifically:
  - `quoting`: only from `received` or `quoting` (idempotent).
  - `quoted`: forbidden on this handler — only the priced-writeback handler can set `quoted` (it has the breakdown/PDF).
  - `approved`: forbidden on this handler — only the customer accept POST can set `approved`.
  - `rejected`: from any non-terminal state (operator decline).
  - `invoiced`: only from `approved` (ABERP DEAL completion).
- **Target session:** S289 sweep. Highest-priority of the sweep work.

### F27 🟡 Operator email surfaced in customer-mail CC

- **Evidence:** `email.ts:301`, `:366`, `:399` all use `cc: [cfg.operator]`. Every customer email exposes `ops@abenerp.com` (or whatever is configured) in the CC field.
- **Why it matters:** CC is visible to all recipients. A customer can extract the operator's address; spammers harvest it; replies-to-all loop the operator.
- **Fix:** use BCC instead. The relay request shape doesn't currently expose BCC (`email-relay.ts:28-35`) — add it. Or send the operator a separate notification email (one fetch per recipient class).
- **Per the test suite (`email.test.ts:251-261`)** the CC behavior is explicitly verified — meaning this was a deliberate choice not an oversight. Flag for design discussion.
- **Target session:** PR-06 (needs ADR-0007 amendment).

### F28 🟢 Honeypot for /api/quote unchanged

`api/quote/+server.ts:87-90` — silent 200 + no persist. ✅ Same posture as PR-K.

---

## 10. Production-readiness gaps

### F29 🔴 `ABERP_INTERNAL_BASE_URL` prod topology is unsolved

- **Walkthrough §"Open questions" #3** names this honestly. `[[email-send-path-pending]]` memory tracks it. ABERP runs on Ervin's Mac at `127.0.0.1:8080`; Lightsail cannot reach it.
- **Until this is solved:** the entire ADR-0007 relay architecture is theoretical in production. The walkthrough's "first run in local-dev variant" is the only path to validate anything beyond intake.
- **Options:**
  - Cloudflare Tunnel from Ervin's Mac to a public hostname → set `ABERP_INTERNAL_BASE_URL=https://aberp-relay.tunnel.cservin69.cf`.
  - Tailscale subnet between Lightsail and Mac.
  - ADR-0006 §A fallback: storefront persists outbound mail to a JSON queue, ABERP polls. This is the "no inbound at all" hardening ADR-0007 sketched.
- **Recommendation:** pick Tailscale (fewest moving parts; one binary on each side; magic-DNS gives the storefront a stable hostname). Cloudflare Tunnel has ToS concerns for non-CF-hosted apps.
- **Target session:** S290+ infra (own arc, not a code session).

### F30 🟡 No documented playbook for the "ABERP offline" customer experience

- **Evidence:** ADR-0007 §"Negative" says "An ABERP-side outage means no customer mail goes out." Mitigation is "persist + retry," which is not implemented (see F16). Walkthrough doesn't address what the customer sees.
- **Today's behavior:** customer submits a quote → notifications skip silently (F8) → customer assumes the form broke → emails support → support emails the operator → operator manually re-runs.
- **Fix:** the customer-facing confirmation page (after submit) should NOT promise an email if the relay is unconfigured/unreachable. Detect ahead of submit (a startup probe to relay's `/api/internal/health` or similar) and show "we've received your CAD; our team will follow up directly within two business days."
- **Target session:** PR-06.

### F-cross 🟢 Catalogue receiver is production-ready

`catalogue-store.ts:42-126` — closed enum, header-injection-safe, lead-time bounded, duplicate-grade detection. PUT body cap 1 MB at handler level. ✅

---

## Walkthrough run readiness — what Ervin should expect NOT to work on first try

Ordered by likelihood of being the first blocker encountered:

1. **Step 3 will get stuck in `Failed after PostingBack`** with a `413 Payload Too Large` from the storefront (F1). The PDF exceeds the 512 KB adapter-node default. **Workaround:** before running the walkthrough, `sudo systemctl edit aberp-site` and add `Environment=BODY_SIZE_LIMIT=52428800` to the `[Service]` block; restart.

2. **Step 5 priced-ready email will not arrive on a cube STEP under 60s wall-clock from Step 1** (F2). The 60s per-recipient cooldown silently drops it. **Workaround:** wait ≥ 60 s between Step 1 and Step 3's `Posted` state, or use a different customer email for each walkthrough run. The skip is silent — `journalctl -u aberp-site` won't show anything about it.

3. **Step 2 "view your quote status" link won't be in the email** (F4, F17). The body lists only the reference UUID. **Workaround:** the operator can hand-construct the URL using `node` on the box: `(node -e "console.log(require('./src/lib/server/quote-token').signQuoteToken('<UUID>'))")` then visit `https://abenerp.com/q/<UUID>?t=<token>`.

4. **Step 6 accept page (when reached) will look right** — typed ACCEPT, RED→GREEN border, big button — but the GET response leaks customer PII (name, email, valid_until) to any email-link prefetcher (F10). Not visible to Ervin; visible to whoever prefetches. Flag as monitor-after-launch.

5. **Step 8 may hang indefinitely** if ABERP's intake daemon polls a different status name than `approved` (F21). The walkthrough flags this; the fix is ABERP-side, not a storefront problem.

6. **Step 7 confirmation email may not arrive** if the relay is unreachable at accept time (F16). State still flips to `approved`; the customer sees green UI; no email lands. **Workaround:** none short of PR-06.

7. **Preflight 3 is doing operator's job** (F8, F19). Storefront should refuse-to-start without the relay env vars. Until S289 lands the fix, operator must hand-edit and restart.

8. **The walkthrough as written validates the LOCAL-DEV variant only** (F20, F29). Even when every step succeeds, that does not validate the production cross-host relay path. **The first real customer's quote on prod will exercise an untested wire path.**

---

## Target-session breakdown for fixes

| Finding                                    | Severity | Target session            | Estimated effort                                        |
| ------------------------------------------ | -------- | ------------------------- | ------------------------------------------------------- |
| F1 BODY_SIZE_LIMIT                         | 🔴       | S289                      | 1 line + 1 test                                         |
| F2 cooldown blocks priced-ready            | 🔴       | S289                      | ~10 lines (per-(recipient,kind) tuple or drop cooldown) |
| F3 status writeback bypasses state machine | 🔴       | S289                      | ~30 lines + 5 tests                                     |
| F4 submission email lacks status link      | 🔴       | S289                      | 5 lines + 1 test                                        |
| F5 status page lacks accept CTA            | 🔴       | S289                      | persist+render, ~40 lines                               |
| F7 HMAC key entropy                        | 🟡       | S289                      | 3 lines                                                 |
| F8 refuse-to-start on relay unconfigured   | 🟡       | S289                      | hooks.server.ts boot check                              |
| F9 stock-alert color                       | 🟡       | S289                      | ~10 CSS lines on 2 surfaces                             |
| F10 PII prefetch headers                   | 🟡       | S289                      | 2 headers                                               |
| F11 mkdir on writePricedPdfAtomic          | 🟡       | S289                      | 1 line                                                  |
| F13 atomic second-write on /api/quote      | 🟡       | S289                      | 1 line                                                  |
| F14 release rate-limit slot on failure     | 🟡       | S289                      | ~5 lines                                                |
| F19 Preflight 3 simplifies after F8        | 🟡       | S289 walkthrough touch-up | doc-only                                                |
| F22 E2E coverage                           | 🟡       | PR-06                     | new arc                                                 |
| F23 status-link regression test            | 🟡       | S289 alongside F4         | 1 line                                                  |
| F16 accept-confirmation retry              | 🟡       | PR-06                     | queue+sweep                                             |
| F20 walkthrough split (local-dev vs prod)  | 🟡       | After F29                 | doc-only                                                |
| F27 BCC operator instead of CC             | 🟡       | PR-06 (needs ADR amend)   | wire-shape change                                       |
| F30 customer-facing "ABERP offline" copy   | 🟡       | PR-06                     | one route, conditional copy                             |
| F29 prod topology resolution               | 🔴       | S290+ infra arc           | not a code session                                      |

S289 is the single sweep PR per `[[overnight-batch-style]]` — bundles F1–F5, F7–F11, F13, F14, F19, F23. PR-06 is the next code arc proper (F16, F22, F27, F30). F29 needs an infra decision that is not a session-able choice.

---

## Confirmed-good summary (the 🟢 list)

For balance against the gap list above, here is what S276–S284 got _right_:

- **HMAC implementation** (quote-token.ts) — domain-separated, constant-time, expiry-bound, dual-acceptance window thought through. Specs cover every attack vector.
- **Atomic file writes** — tmpfile + rename consistently across all stores.
- **Catalogue receiver** — closed enum, header-injection-safe, duplicate detection, body cap, validates each row independently.
- **Priced-writeback state machine** — terminal/hash-mismatch/different-hash all 409 correctly; idempotent same-hash returns 200 no-op.
- **Path traversal protection** — `pathResolve` + `startsWith(root + '/')` everywhere.
- **Test breadth** — 224 unit tests, 16 spec files, covers HMAC, relay, validation, error paths.

The arc is structurally sound; what's missing is the connective tissue between the seams. The S289 sweep can close most of the 🔴 list without rearchitecting anything.

---

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md)
- ADRs — [0002](../adr/0002-auto-quote-architecture-split.md), [0003](../adr/0003-material-catalogue-receiver.md), [0004](../adr/0004-priced-quote-writeback.md), [0005](../adr/0005-hmac-accept-link-expiry.md), [0007](../adr/0007-storefront-email-relay-via-aberp.md)
- Walkthrough — [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md)
- Parent project memory — `[[aberp-auto-quoting]]`, `[[aberp-quoting-design-addenda]]`
- Storefront memory — `[[aberp-site-ssr-live]]`, `[[email-send-path-pending]]`, `[[aberp-site-smtp-broken]]`
- Feedback memory referenced — `[[pushback-as-method]]`, `[[trust-code-not-operator]]`, `[[hulye-biztos]]`, `[[walkthrough-format]]`, `[[overnight-batch-style]]`, `[[parallel-doc-sessions]]`, `[[origin-clean-topology]]`
