# ADR 0007 — Storefront customer email relays through ABERP (`POST /api/internal/send-email`)

**Status:** Accepted (2026-06-07, S280 / PR-04-doc).
**Supersedes:** [ADR-0006](0006-local-smtp-send-no-relay.md).
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §9.

## Context

[ADR-0006](0006-local-smtp-send-no-relay.md) (2026-06-06, S276 / PR-01) pinned "storefront sends customer email directly via local SMTP; no ABERP relay endpoint." Its core argument was that `[[aberp-smtp-spoc]]` is about **credential values** (which mailbox authenticates), not **process locality** (which process holds the creds). By that reading, two surfaces holding the same `SMTP_USER` / `SMTP_PASS` satisfies SPOC.

Field truth changed the picture (Ervin, mid-S277, 2026-06-06):

> "Storefront SMTP NOT WORKING" → (clarified minutes later) "The creds are there but would like to consolidate."

The literal operational symptom ("NOT WORKING") was misleading — the local SMTP creds in `/etc/aberp-site.env` do work. What Ervin actually wants is **consolidation**: a single sender identity for both ABERP-side invoice mail and storefront-side customer mail. Two surfaces sending as the same mailbox via two independently-rotated copies of the credential fragments **sender reputation**, **SPF/DKIM lineage**, and **audit trail**. That fragmentation is exactly what the original `[[aberp-smtp-spoc]]` rule was meant to prevent; ADR-0006's "values-not-locality" reading was technically defensible but missed the spirit.

The S276 brief's original premise (storefront emails relay through ABERP via an internal endpoint) was the right architecture; ADR-0006's pushback was wrong about ABERP's network posture (HTTPS-only outbound from the storefront _can_ reach an authenticated endpoint on ABERP — the rejected mechanism was actually viable). Per `[[pushback-as-method]]`, pushback is method, not dogma — this is a case where the pushback was thoughtful but proven wrong by deployment reality.

## Decision

The storefront sends customer email through **ABERP** via an internal HTTPS endpoint:

```
POST /api/internal/send-email
Authorization: Bearer <ABERP_EMAIL_RELAY_TOKEN>
Content-Type: application/json

{
  "to": ["customer@example.com"],
  "cc": ["sales@aberp.example"],          // optional
  "subject": "Ajánlat 7af2 — készen áll / Your quote is ready",
  "body_text": "…plain-text fallback…",
  "body_html": "…html body…",             // optional
  "attachments": [                        // optional
    {
      "filename": "quote.pdf",
      "content_type": "application/pdf",
      "data_b64": "<base64>"
    }
  ]
}
```

Responses:

- `200 { "audit_id": "<aberp-side audit event id>" }` — accepted and either sent or queued (ABERP side decides).
- `401` — missing/invalid bearer.
- `413` — request body or total attachment size exceeds the relay cap.
- `503` — ABERP's downstream SMTP is currently failing and the relay is not queueing (or queue is full).

Single set of SMTP credentials lives on ABERP (`[[aberp-smtp-spoc]]` enforced for real, not by value-duplication). Single sender identity, single SPF/DKIM, single rotation, single audit lineage.

### Auth

Bearer token in a dedicated env var on the storefront (`ABERP_EMAIL_RELAY_TOKEN`), distinct from `ABERP_QUOTE_INTAKE_TOKEN`. Two tokens → independent rotation; a compromised email-relay token doesn't grant access to the quote-intake surface and vice versa. ABERP rejects any caller whose token doesn't match the dedicated email-relay key.

### Audit

Each ABERP-side relay emits an `email.relayed_storefront` audit event with:

- submitter identity (`storefront`)
- recipient address **hashed** (SHA-256, salted) — plaintext recipient is not stored at rest, per GDPR minimization
- subject (kept plaintext — needed for support triage; not PII-sensitive in our domain)
- byte size of the rendered message + attachments
- timestamp, audit_id (returned to storefront in the 200)

### Wire surface and Lightsail topology

The storefront-to-ABERP call is **HTTPS outbound** from the storefront. Lightsail allows HTTPS outbound by default; SMTP port 25/587 outbound (which the local-SMTP path used) is allowed too but is the very thing whose reputation we're consolidating away from on the storefront side. ABERP's existing TLS endpoint terminus (already serving the quote-intake side) accepts this new route.

ABERP-side change for this: a new HTTPS-accepting endpoint on the same listener that already terminates the quote-intake polling traffic. This re-opens the question ADR-0006 closed about "ABERP public inbound surface" — see [Reconciliation with ADR-0006](#reconciliation-with-adr-0006) below.

## Reconciliation with ADR-0006

ADR-0006 rejected this architecture partly on "ABERP has **no public inbound HTTP surface**" grounds (citing ABERP-side ADR-0057 / `[[aberp-site-ssr-live]]`). That claim was overstated: ABERP runs an outbound-poller for quote intake (it _pulls_ from the storefront), but it _is_ reachable on its own TLS endpoint for authenticated callers — the "no public inbound" rule was about not exposing a customer-facing surface, not about disallowing internal authenticated callers. ADR-0007 adds an authenticated internal callable; it does not expose anything customer-facing.

If a future audit requires hardening "no inbound at all" (e.g., a stricter posture during SaaS migration per `[[aberp-saas-migration]]`), the fallback is the staged-pending-mail variant ADR-0006 §A described — storefront persists outbound mail to a JSON file, ABERP polls and sends. That variant is documented but **not picked** for v1: the latency cost (poll-cadence-bound, 60s+ instead of immediate) and the doubled daemon responsibility are real, and Ervin's "consolidate" mandate is satisfied today by the direct-relay path.

## Consequences

### Positive

- **Single sender identity.** One SMTP credential, one SPF/DKIM record, one sender-reputation pool. `[[aberp-smtp-spoc]]` enforced architecturally, not by operator discipline.
- **Single audit lineage.** Every outbound customer mail emits an `email.relayed_storefront` event on ABERP; one ledger answers "did we send this customer their quote?"
- **Single rotation point.** Credential changes happen on ABERP; the storefront's `ABERP_EMAIL_RELAY_TOKEN` is the only secret it holds, rotated independently of SMTP.
- **A storefront outage doesn't affect outbound mail provenance.** The relay is server-to-server; mail still comes from the canonical sender identity regardless of which storefront process originated the request.

### Negative

- **New endpoint to authn correctly.** `/api/internal/send-email` must be tightly bearer-gated. A weak check is worse than the rejected status quo because it would expose ABERP's SMTP as a spam relay.
  - Mitigation: dedicated token (separate from quote-intake), constant-time comparison, no fallback auth path.
- **A storefront-side process retains the local SMTP creds for a deprecation window.** During the window the env file (`/etc/aberp-site.env`) still has `SMTP_USER` / `SMTP_PASS`; the storefront's `email-send` helper is rewired to the relay path so those env vars become unused. Operator removes them once a deploy or two have run cleanly.
  - Mitigation: surface the unused creds as an explicit deprecation log on storefront startup until removed.
- **An ABERP-side outage means no customer mail goes out.** Today's direct-local-SMTP path tolerates ABERP being offline; the relay path doesn't.
  - Mitigation: the storefront should persist the email-send request and surface a Sending/Queued state to the user per `[[post-issue-async]]`, retrying with exponential backoff. The PDF and metadata are already on the storefront disk, so the request can be reconstructed from `/data/quotes/{id}/`.

### Neutral

- The existing `email.ts` rate-limit posture on the storefront (`GLOBAL_MAX`, `RECIPIENT_COOLDOWN_MS`) is preserved for the storefront-side helper, but the authoritative rate-limit moves to ABERP (since ABERP now sees all outbound mail across surfaces).
- ABERP-side companion work is a separate session (likely 1 PR): endpoint exposure, token check, audit event kind, optional queue table.

## Validation

PR-04 (the implementation session) cannot ship until a real test email lands in Ervin's mailbox via the new relay path. Per `[[trust-code-not-operator]]`, mailbox arrival is the validation — not log lines, not test assertions about the HTTPS call. The audit event with `email.relayed_storefront` and the matching `audit_id` returned in the 200 is the in-code record.

Integration test additions on PR-04:

- `sendPricedReadyEmail(metadata, pdfPath)` calls the relay path (not local SMTP).
- A 401 from the relay logs and is swallowed; the priced-writeback POST does not 500.
- A 503 from the relay queues the request to retry on the storefront side (does not lose the mail).
- A 200 from the relay records the returned `audit_id` in the quote metadata for traceability.
- The local-SMTP send code path is no longer called (regression-tested by absence of nodemailer transport instantiation in the priced-writeback flow).

## Open questions (for the PR-04 implementation session)

1. **Should ABERP queue when its own downstream SMTP is temporarily down?**
   Conservative pick: yes. Persist failed sends to an `outbound_email_queue` table on ABERP with a retry policy (exponential backoff, hard cap 24h, dead-letter after). Storefront still gets a 200 with an audit_id; ABERP's audit ledger tracks `email.relayed_storefront` (intake) and a later `email.sent_relayed` (egress) separately. Reduces blast radius of upstream SMTP flakiness and gives one source of truth for "what's stuck."

2. **Should the relay be rate-limited per-caller?**
   Likely yes — token-bucket per bearer token, capacity matching today's storefront `GLOBAL_MAX` (~30/min). Protects against a compromised storefront token being used to spam. Implementation lives on the ABERP side; the storefront side does not need to know the cap (any 429 from the relay is queued like a 503).

3. **Attachment size cap and total request size?**
   Suggested: 25 MB total request body, 20 MB per attachment, 5 attachments max. PR-04 storefront sends one PDF (typically < 2 MB); the cap is for safety not for the happy path.

4. **What happens to the existing `sendQuoteNotifications` path in `src/lib/server/email.ts`?**
   PR-04 should rewire it (operator mail + customer "we received your CAD" + new "your quote is priced") to the relay. The local-SMTP nodemailer transport stays in the file until the deprecation window closes (one or two deploys), then removed.

5. **Deprecation window length for local SMTP env vars on `/etc/aberp-site.env`?**
   Suggested: one calendar week after PR-04 deploys, with a startup log on the storefront flagging unused `SMTP_*` vars. Operator removes them; the storefront's env-loader stops reading them in the PR after that.

## References

- Field-truth memory — `project_aberp_site_smtp_broken.md` (2026-06-06, Ervin mid-S277)
- Superseded ADR — [ADR-0006](0006-local-smtp-send-no-relay.md)
- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §9
- Existing email impl (to be rewired) — [`src/lib/server/email.ts`](../../src/lib/server/email.ts)
- `[[aberp-smtp-spoc]]` — credential SPOC rule, now enforced by architecture not by value-duplication
- `[[trust-code-not-operator]]` — mailbox arrival is the validation, not operator memory
- `[[pushback-as-method]]` — pushback as method, not dogma; this is a case where field truth overturned a thoughtful pushback
- `[[post-issue-async]]` — surface Sending/Queued states when a downstream is unavailable rather than blocking the user
- ABERP-side ADR-0057 — quote-intake architecture (operator-pull); ADR-0007 adds an internal authenticated callable without changing the customer-facing-inbound posture
