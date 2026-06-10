# ADR 0009 — Storefront-as-queue: ABERP polls outbound, no tunnel, no third party

## Status

Accepted — 2026-06-09 (Ervin).

## Supersedes

- [ADR-0007](0007-storefront-email-relay-via-aberp.md) — push-based email relay from storefront to ABERP.
- [ADR-0008](0008-aberp-storefront-network-topology.md) — Cloudflare Tunnel as the chosen network topology. ADR-0008 was Accepted on the night of 2026-06-08 and reversed on the morning of 2026-06-09 before its runbook was executed; no `cloudflared` daemon was ever brought up against prod.

## Context

The connectivity gap described in [ADR-0008 §Context](0008-aberp-storefront-network-topology.md#context) is unchanged:

- **Storefront** runs on AWS Lightsail (Ubuntu), public via CloudFront at `abenerp.com`. Outbound HTTPS works; inbound HTTPS works.
- **ABERP** runs on Ervin's MacBook as a Tauri-hosted service, binds to `127.0.0.1:<dynamic-port>`. Reachable only via loopback. No public IP, no DNS name, no inbound TLS terminus.

The auto-quote pipeline shipped in S276–S284 has three cross-stack call legs ([ADR-0004](0004-priced-quote-writeback.md), [ADR-0007](0007-storefront-email-relay-via-aberp.md), plus the existing ABERP-side outbound poll). Two of those — priced-quote writeback and customer email relay — were push-shaped (storefront → ABERP POST). Push requires the storefront to reach ABERP, which the loopback-only listener cannot satisfy without something in the middle.

**What changed between ADR-0008 and this ADR is Ervin's threat model**, not the network topology:

> "I am paranoid about security but that means I do not trust cloudflare neither." — Ervin, 2026-06-09 morning, after sleeping on ADR-0008's pick.

The vendor-trust axis under Ervin's threat model now rules out every third-party-network option:

- **Cloudflare (B)** — vendor sees plaintext relay traffic at the edge. DPA available, EU PoPs available, but the traffic-path visibility itself is what's rejected.
- **Tailscale (C)** — same class of dependency. Tailscale's coordination server doesn't see payload, but the company is still a third party in the critical-path. Equivalent rejection.
- **Self-hosted WireGuard (E)** — no third party in the wire, but Mac sleep + recurring maintenance (key rotation, OS-upgrade break-fix, firewall audits) violate `[[trust-code-not-operator]]`. Quoted to Ervin at "30 min to stand up, ongoing recurring debt"; he rejected the ongoing debt.

ADR-0008's [Option D](0008-aberp-storefront-network-topology.md#option-d--storefront-as-queue-aberp-polls-no-inbound-to-aberp-at-all) ("storefront-as-queue, ABERP polls") was preserved as the documented fallback "if a future audit or compliance ask makes 'zero inbound to ABERP' load-bearing." The audit is Ervin. The compliance ask is "I do not trust any vendor in the email path." D is now the chosen path, not the fallback.

## Decision

**ABERP polls storefront outbound for ALL state transitions.** Storefront persists every cross-service event as a file in a queue directory on its own disk. Mac (ABERP) makes only outbound HTTPS requests to the storefront's public `abenerp.com` surface. Storefront's public endpoint serves multiple polling APIs.

### Polling endpoints (storefront exposes, ABERP consumes)

- `GET /api/quotes?status=received` — new submissions awaiting pricing.
- `GET /api/quotes?status=approved` — accepted quotes awaiting DEAL (already exists, S211 daemon).
- `GET /api/internal/email-queue?since=<iso>` — outbound emails awaiting send (NEW).

### Write-back endpoints (ABERP POSTs)

- `POST /api/quotes/{id}/priced` — multipart writeback with PDF (already exists, S278).
- `POST /api/internal/email-queue/{id}/sent` — mark email delivered (NEW).
- `POST /api/internal/email-queue/{id}/failed` — mark email failed with error (NEW).

### Authentication

All endpoints bearer-token gated. The storefront-admin token (`ABERP_SITE_ADMIN_TOKEN`, existing) is reused for the new queue endpoints. No new tokens introduced; no new secrets to rotate.

### Removed surfaces

- **ABERP's `POST /api/internal/send-email` (S281).** DEPRECATED. Kept available for local-dev mode (single-process testing), with a deprecation warning if called in prod. Removed in a later session once the email-queue path has been verified end-to-end.
- **Storefront's `sendEmailViaABERP` relay client.** REPLACED with `enqueueEmail` that writes to the local queue file on the Lightsail disk instead of making an outbound HTTP call.

## Wire shape: email queue entry

Stored as JSON in `<data>/email-outbox/<entry-id>.json`. State directories carry the lifecycle:

```
/var/lib/aberp-site/email-outbox/
  queued/<id>.json     ← storefront writes here
  claimed/<id>.json    ← ABERP daemon renames into here before sending (optimistic lock)
  sent/<id>.json       ← ABERP daemon renames after successful SMTP send
  failed/<id>.json     ← ABERP daemon renames after retry budget exhausted
```

Entry payload:

```json
{
	"id": "01H...",
	"queued_at": "2026-06-09T...",
	"to": ["customer@example.com"],
	"cc": [],
	"subject": "...",
	"body_text": "...",
	"body_html": "...",
	"attachments": [{ "filename": "...", "content_type": "...", "data_b64": "..." }],
	"submitter": "submission_received|priced_ready|accept_confirmation|other",
	"state": "queued",
	"attempt_n": 0,
	"last_error": null,
	"sent_at": null,
	"audit_id": null
}
```

State transitions: `queued → claimed → sent` or `queued → claimed → failed`. ABERP-side daemon claims with optimistic-locking — atomic `rename(queued/{id}.json, claimed/{id}.json)` before opening the SMTP connection. A second daemon racing the rename gets `ENOENT` and moves on. After delivery: rename `claimed/{id}.json` to `sent/{id}.json` (writing the final payload with `sent_at` filled). On retry-budget exhaustion: rename to `failed/{id}.json` with `last_error` populated.

Per `[[no-sql-specific]]`: the queue is filesystem JSON, the state machine is app-layer. No SQLite, no Postgres, no Redis.

## Architecture diagram

```
  Customer browser
       │
       ▼
  https://abenerp.com (Lightsail / CloudFront)
       │
       ├── submit quote   → write quote_requests/<id>.json (state: received)
       ├── status page    → read  quote_requests/<id>.json
       ├── accept link    → write quote_requests/<id>.json (state: approved)
       └── (storefront)   → write email-outbox/queued/<id>.json (any state change)

  Ervin's Mac (ABERP)
       │
       └── outbound HTTPS only →
              │
              ├── GET  /api/quotes?status=received          (every 60s)
              ├── GET  /api/quotes?status=approved          (every 300s)
              ├── GET  /api/internal/email-queue?since=...  (every 5s)
              ├── POST /api/quotes/<id>/priced              (when priced)
              └── POST /api/internal/email-queue/<id>/sent  (when emailed)
                  POST /api/internal/email-queue/<id>/failed
```

No tunnel. No inbound port on Mac. No third party.

## Consequences

### Positive

- **Zero recurring maintenance.** No OS-upgrade break-fix on a tunnel daemon, no key rotation for a vendor, no firewall-rule audit, no third-party DPA review on email-relay traffic.
- **Survives Mac sleep.** Queued requests pile up on Lightsail; ABERP catches up when the Mac wakes. Customer-facing UX: the submission acknowledgment email still queues and sends as soon as ABERP next polls (in the worst case ~5s after wake); the priced-ready email arrives whenever pricing finishes, naturally bounded by the time the lid is open.
- **Aligns with existing pattern.** ABERP already polls NAV outbound for accounting state; ABERP already polls the storefront for accepted quotes (S211, S294). This adds one more polling daemon in the same shape. No architectural novelty.
- **Auditability is filesystem-native.** Every email request is a JSON file on disk with creation / claim / sent / failed timestamps in the directory layout. Forensic walks are `ls` + `cat`.
- **No vendor risk.** No Cloudflare DPA, no Tailscale account, no fourth-party processor in the email path. The relay's traffic-path visibility — the thing Ervin's threat model rejected — is reduced to "Áben Consulting Kft. infrastructure only" (Lightsail + a MacBook on Ervin's home network).
- **`ABERP_INTERNAL_BASE_URL` disappears as a concern.** The env var is never set on Lightsail; the call shape it gated doesn't exist. One less reconciliation knob ([[email-send-path-pending]]).

### Negative

- **Latency floor.** Poll cadence (5s for email, 60s for new quotes) means worst-case ~5s delay between "ABERP renders email" and "customer receives email," ~60s between "customer submits" and "ABERP starts pricing." Vs. push-based ~2s under Cloudflare Tunnel. For indicative quotes this is fine; the customer doesn't see the polling delay because the submission acknowledgment goes out via the queue too (5s round-trip from form submit to mailbox is acceptable).
- **Engineering work to build.** ~2 dispatch sessions (S306 storefront-side `enqueueEmail` + `GET /api/internal/email-queue` + `POST .../sent` + `POST .../failed`; S307 ABERP-side polling daemon, claim/send/mark loop, retry policy). Vs. ~30 min for WireGuard setup. The engineering work is a one-time cost; the WireGuard maintenance was recurring — Ervin's pick.
- **Storefront disk usage grows.** Every email + every quote sits on disk indefinitely until a cleanup policy lands. See [Open question 2](#open-questions) below. Bounded growth; one quote-flow is a handful of KB. Multi-year accumulation is still small but a cleanup is wanted before then.
- **Storefront's local SMTP question reopens.** If storefront also needs to send emails (it shouldn't, per `[[aberp-smtp-spoc]]`), where does that send from? Answer: storefront **never** sends directly under this ADR. It only enqueues. ABERP delivers using ABERP's SMTP credentials. Single sender identity preserved — the same SPOC outcome ADR-0007 achieved, by a different mechanism.

### Neutral

- **`ABERP_EMAIL_RELAY_TOKEN`** on storefront becomes unused. Leave the secret provisioned in Ervin's keychain for local-dev / manual API testing; remove from `/etc/aberp-site.env` in a follow-up cleanup. Not load-bearing.
- **Polling cadence is configurable per-tenant** in the ABERP SPA, mirroring S211's pattern. Per `[[trust-code-not-operator]]` the default should not require Ervin to remember to tune it; sensible defaults (5s email, 60s quotes) ship as constants and the SPA can override.

## Open questions

1. **Where does the email queue live on Lightsail's disk?** Suggest `/var/lib/aberp-site/email-outbox/{queued,claimed,sent,failed}/`, with the directories created by `systemd-tmpfiles` on boot. Owned by the storefront process user; ABERP polls via HTTPS only and never touches the filesystem directly. Resolved in S306.
2. **What's the cleanup policy for `sent/` and `failed/` entries?** Suggest a nightly cron on Lightsail that moves entries older than 90 days to `/var/lib/aberp-site/email-outbox-archive/` (compressed tarball per day). Backlog for a later session — not blocking S306/S307.
3. **Should `GET /api/internal/email-queue?since=...` paginate?** Yes — bounded result size (default 50 entries per page, `next_cursor` in the response). Even in failure modes (ABERP offline for hours), the cap protects the response payload. Backlog refinement; the trivial-list shape is fine for the v1 cut.
4. **Should the ABERP poll cadence be configurable per-tenant in the SPA?** Suggest yes — same pattern as S211's quote-intake daemon. Backlog; not blocking S306/S307.
5. **What about the existing `aberp.email_relay.prod.email_relay_token` keychain entry on Ervin's Mac?** Provisioned for the now-deprecated `POST /api/internal/send-email`. Keep around for local-dev mode + manual API testing. No removal needed. The entry stops mattering operationally once S307 ships.
6. **What about the existing pre-built S281 endpoint on ABERP?** Leave it wired for local-dev mode (so single-process tests still pass) and emit a deprecation warning in any non-local environment. Schedule removal in a session after the queue path has been verified end-to-end through one real customer quote. Backlog.

## Validation criterion

Per `[[trust-code-not-operator]]`: before declaring this architecture working end-to-end, send a real test customer flow through prod and verify three emails arrive in Ervin's inbox:

1. Submit on `abenerp.com/quote` → expect `submission-received` email (Hungarian + English, per the existing template).
2. Wait for ABERP to poll the new-submission feed, run pricing, write back the priced PDF → expect `priced-ready` email + PDF attachment.
3. Click accept on the customer's status page → expect `accept-confirmation` thank-you email.

All three emails arrive in Ervin's inbox. The audit trail on Lightsail shows three `email-outbox/sent/<id>.json` files with `sent_at` timestamps and matching `audit_id`s from ABERP. **No tunnel. No Cloudflare. No third party in the audit trail.**

If any of (1)–(3) fail under this architecture, the ADR should be reopened.

## References

- `[[trust-code-not-operator]]` — extended here to "trust no vendor"; the rejection of Cloudflare / Tailscale / WireGuard-maintenance is rooted in the same principle that rejected ADR-0008's Option A (cert-on-desktop) and Option E (recurring maintenance).
- `[[aberp-smtp-spoc]]` — single sender identity preserved. ABERP still holds the only SMTP credential; storefront only enqueues.
- `[[no-sql-specific]]` — queue is filesystem JSON, app-layer state machine. No database.
- `[[aberp-saas-migration]]` — when ABERP moves to a real long-lived server, the polling endpoint URL is the only env var to change. The architecture transports cleanly; no third-party dependency to migrate.
- `[[pushback-as-method]]` — this ADR is Ervin's pushback against ADR-0008's vendor pick, taken seriously and turned into a documented architectural reversal rather than soft-peddled.
- [ADR-0004](0004-priced-quote-writeback.md) — priced-quote writeback wire shape; preserved (POST endpoint unchanged, polling-driven instead of push-driven from ABERP's side).
- [ADR-0007](0007-storefront-email-relay-via-aberp.md) — **SUPERSEDED** by this ADR.
- [ADR-0008](0008-aberp-storefront-network-topology.md) — **SUPERSEDED** by this ADR.
- [`docs/runbooks/cloudflare-tunnel-aberp.md`](../runbooks/cloudflare-tunnel-aberp.md) — to be deleted in a follow-up session now that this ADR is accepted.
- [`docs/walkthroughs/end-to-end-auto-quote-test.md`](../walkthroughs/end-to-end-auto-quote-test.md) §"What's NOT in this walkthrough" OQ #3 — closed by this ADR (no topology to stand up; ABERP polls outbound only).

## Addendum — S343: catalogue state dir

The same canonical-state-dir convention this ADR established for the email outbox (`/home/aberp/data/email-outbox/`) governs the material catalogue snapshot:

- The catalogue snapshot lives at `/home/aberp/data/catalogue/materials.json`, overridable via `ABERP_SITE_CATALOGUE_DIR` (absolute paths only).
- Release directories are immutable per deploy hygiene — the systemd unit runs `ProtectSystem=strict` and only whitelists `/home/aberp/data` (+ the `/mnt/aberp-data` EBS mountpoint it symlinks) under `ReadWritePaths=`. **Application state must live OUTSIDE any release dir.**
- Before S343, `catalogue-store.ts` defaulted to the process-CWD-relative `./data/catalogue`, which resolved inside the read-only release dir. Every `PUT /api/catalogue/materials` failed with `EROFS: read-only file system` and the `/quote` material dropdown never populated. S343 sets the absolute default, rejects relative overrides, and adds the `F-CAT` boot check (mirroring `F15` for the outbox) so a misconfigured deploy refuses to start with an actionable message instead of silently 500-ing every catalogue push. This is the catalogue analogue of the S311 outbox path-resolution fix.
