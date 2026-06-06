# ADR 0006 — Local SMTP send (no internal email-relay endpoint)

**Status:** Accepted (2026-06-06, S276 / PR-01). Pushback against the S276 brief's "via internal email-send endpoint" premise.
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §9.

## Context

The S276 brief, briefing the storefront-side auto-quote design, included:

> "SMTP via existing ABERP SPOC (per `[[aberp-smtp-spoc]]`). Storefront cannot have its own SMTP creds; uses ABERP's via an internal email-send endpoint."

That sentence conflates two distinct concerns: **credential SPOC** (which mailbox the credentials authenticate as) and **process locality** (which process holds them). The `[[aberp-smtp-spoc]]` memory rule is about the first; the brief's recommendation acts on the second.

Today's prod reality (PR-K, in `/etc/aberp-site.env` on the Lightsail box):

```sh
SMTP_HOST=…
SMTP_USER=…
SMTP_PASS=…
SMTP_FROM=…
ABERP_SITE_OPERATOR_EMAIL=…
```

The storefront sends customer mail directly via `src/lib/server/email.ts:222` (`sendQuoteNotifications`). That code shipped at PR-K, has been live since 2026-06-02 (per `[[aberp-site-ssr-live]]`), and is rate-limited (`GLOBAL_MAX = 30/min`, `RECIPIENT_COOLDOWN_MS = 60_000`).

ABERP-side reality: ABERP has **no public inbound HTTP surface** (Tauri loopback HTTPS, ADR-0057). The storefront cannot POST to ABERP to ask it to send mail without first puncturing ABERP's network posture.

This ADR pins the correction so future sessions don't drift back into "go through ABERP for email."

## Decision

The storefront sends customer email **directly** via the locally-configured SMTP creds. **No internal email-send relay endpoint is built**, on ABERP or anywhere else.

The new "Your quote is ready" customer message (PR-04) is authored as a new function in [`src/lib/server/email.ts`](../../src/lib/server/email.ts), invoked from the `POST /api/quotes/{id}/priced` handler on the `quoted` transition. PDF attachment lives on disk at `/data/quotes/{id}/priced.pdf` and is read into the message via nodemailer's `attachments` array.

The credential SPOC rule (`[[aberp-smtp-spoc]]`) is preserved by **keeping the credential values identical across surfaces**:

- `/etc/aberp-site.env` on Lightsail and ABERP's keychain on Ervin's Mac BOTH hold the same `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`.
- Operator discipline (today): when the SMTP secret is rotated, both surfaces are updated.
- This is **operator discipline** — by the letter of `[[trust-code-not-operator]]` we should automate the rotation. Per `[[pushback-as-method]]`, in this case the discipline is acceptable because rotation is rare (≤ 1× / year), the failure mode is loud (mail bounces), and the alternative (automated push) re-introduces the public-inbound-surface problem we just rejected.

## Alternatives considered

### A — Storefront stages outbound mail; ABERP polls and sends (the brief's premise, mechanized)

Storefront persists pending mail (e.g. `/data/quotes/{id}/pending-mail.json`). ABERP's poll daemon picks up pending mail entries on each cycle and sends.

**Rejected** for three reasons:

1. **Three round-trips for one mail.** Submit → write pending → ABERP polls → ABERP fetches → ABERP sends → ABERP writes back "sent." Latency to customer inbox is now poll-cadence-bounded (60s+) instead of immediate.
2. **Email-failure semantics propagate badly.** A bounce on ABERP's send has to flow back to the storefront's metadata, which is one more wire surface. Today's direct send writes `notified_at` in-process — one transaction, one log.
3. **The new daemon path is a new bug surface.** Today's quote-intake daemon is the only ABERP→storefront poll loop. Adding outbound-mail polling doubles the daemon's responsibility for no architectural gain.

### B — Storefront calls a public ABERP endpoint (the brief's literal phrasing)

POST from storefront to `https://aberp.something/internal/send-mail`.

**Rejected, hard.** ABERP has no public inbound surface (`[[aberp-site-ssr-live]]` documents this; ADR-0057 enshrines it). Punching a hole for one endpoint defeats the whole "operator-pull, never inbound" architecture and creates exactly the SaaS-migration risk the desktop-first posture exists to avoid (`[[aberp-saas-migration]]`).

### C — Storefront uses an external transactional-email service (SendGrid / Postmark / SES)

A third-party API key replaces SMTP creds.

**Rejected** on `[[spacex-vertical-integration]]` grounds — every external dependency is debt. SMTP-direct to the existing mailbox host is self-contained and already works.

### D — Today's direct local SMTP (the pick)

The storefront sends via `src/lib/server/email.ts`. Credential SPOC honored by **value identity**, not by **process identity**.

## Consequences

### Positive

- **Immediate customer email** on priced-writeback. No poll-cadence latency.
- **Single-transaction state-and-notify.** Same Node process writes `metadata.json` and queues the mail; failure semantics are one place.
- **No new endpoint, no new daemon, no new wire surface.** The smallest possible change.
- **Preserves the desktop-first ABERP architecture.** ABERP stays purely outbound-polling; no inbound surface introduced.

### Negative

- **Credential duplication.** `SMTP_PASS` lives in two places: Lightsail `/etc/aberp-site.env` and ABERP keychain. Operator must sync on rotation.
  - Mitigation: rotation is rare; both surfaces emit a loud bounce log if the value drifts.
- **A spam-list event on one mailbox affects both surfaces equally.** Same `SMTP_USER` is reused; if the mailbox gets rate-limited by the upstream provider, both ABERP invoice email and storefront customer email feel it.
  - Mitigation: this is the SPOC rule's whole point. If/when we want surfaces to be independently rate-limited, the right answer is two mailboxes (`invoices@aberp` + `quotes@aberp`), not a relay.

### Neutral

- The `email.ts` rate-limit posture (`GLOBAL_MAX`, `RECIPIENT_COOLDOWN_MS`) covers the new message naturally — no new code needed for limits.
- A future SaaS migration (`[[aberp-saas-migration]]`) puts ABERP behind a public surface; at that point the architecture may consolidate mail in ABERP. The pin is "decided for v1," not "decided forever."

## Validation

PR-04 integration tests:

- `sendPricedReadyEmail(metadata, pdfPath)` is called from the priced-writeback handler on `received|quoting → quoted` transition.
- Email body includes the signed accept URL.
- PDF is attached.
- Rate-limit blocks a second send to the same recipient within `RECIPIENT_COOLDOWN_MS` (today's behavior preserved).
- `notified_at` is updated on the metadata on success.
- A send failure logs and is swallowed (does not 500 the priced-writeback POST).

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §9
- Existing email impl — [`src/lib/server/email.ts`](../../src/lib/server/email.ts)
- `[[aberp-smtp-spoc]]` — credential SPOC rule (about credential values, not process locality)
- `[[aberp-site-ssr-live]]` — Lightsail runtime, env-var topology
- ABERP-side ADR-0057 — quote-intake architecture (operator-pull-only)
