# ADR 0004 — Priced-quote writeback contract

**Status:** Accepted (2026-06-06, S276 / PR-01). Implements [ADR-0002](0002-auto-quote-architecture-split.md).
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §6.

## Context

Per ADR-0002, ABERP runs the scoring engine and produces the indicative quote (breakdown + PDF). The storefront needs a wire surface where ABERP can deposit that artifact and a state-machine hook that flips the quote into `quoted` so the customer can be notified.

The existing intake-writeback (`POST /api/quotes/{id}/status` with `{ status, notes }`) flips status but carries no payload. Cramming the breakdown + PDF into `notes` is wrong (limits, encoding, multipart-ness). A new endpoint is right.

## Decision

A new endpoint `POST /api/quotes/{id}/priced` lands in PR-03.

### Wire shape

`multipart/form-data` with two parts:

```
Content-Disposition: form-data; name="meta"
Content-Type: application/json

{ "breakdown_json": { … opaque, ABERP-internal … },
  "valid_until": "2026-07-06",
  "feature_graph_hash": "blake3:1a2b3c…",
  "extractor_version": "aberp-cad-extract@0.4.1",
  "engine_version": "aberp-quote-engine@0.7.0",
  "stock_alert": false }
```

```
Content-Disposition: form-data; name="pdf"; filename="quote.pdf"
Content-Type: application/pdf

<binary>
```

### Auth

`requireAdminAuth(request)` — the SPOC bearer `ABERP_SITE_ADMIN_TOKEN` (== ABERP's `quote_intake_token`).

### Validation

- `id` matches today's UUID regex.
- The quote must exist (404 otherwise).
- The quote must be in `received` or `quoting` state (409 otherwise — see "idempotency" below).
- `breakdown_json` is a JSON object (storefront does NOT inspect its keys — opaque, per ADR-0002).
- `valid_until` is an ISO date (`/^\d{4}-\d{2}-\d{2}$/`), in the future.
- `feature_graph_hash` matches `/^blake3:[0-9a-f]+$/`.
- `extractor_version` / `engine_version` are non-empty ASCII, max 100 chars each.
- `stock_alert` is a boolean.
- `pdf` part is `application/pdf`, ≤ 5 MB (sanity cap — typical indicative PDF is ≤ 200 KB).
- Header-injection-safe on every string.

### Persistence

- Write the PDF to `/data/quotes/{id}/priced.pdf` (atomic: tmpfile + rename).
- Extend `metadata.json` with the new `pricing` block (per design doc §4 schema), atomic write via `writeQuoteAtomic`.
- Append `status_history` row: `{ at, from, to: "quoted", notes: "Priced by aberp-quote-engine <ver>, valid_until <date>" }`.
- Flip `metadata.status = "quoted"`.

### Idempotency

- A re-POST with the **same `feature_graph_hash`** on a `quoted` quote: returns `200`, no state mutation. ABERP daemons can safely retry on transport flake.
- A re-POST with a **different `feature_graph_hash`** on a `quoted` quote: returns `409 { "error": "already_priced_with_different_hash" }`. ABERP-side §10 commits that regeneration mints a new `quote_id`, so this case should never legitimately happen — the 409 catches a bug.
- A re-POST on an `approved` / `rejected` / `invoiced` quote: returns `409 { "error": "terminal_or_committed" }`. The customer has already accepted; the price is frozen per `[[trust-code-not-operator]]` and ABERP-side §10.

### Side effects

On the `quoted` transition (and only on a _new_ priced write, not idempotent replay), the storefront:

1. **Sends the customer email** "Your quote is ready" with the PDF attached and the HMAC accept link. Per ADR-0006 (local SMTP send), this is direct via `src/lib/server/email.ts`.
2. **Logs a notification record** in metadata.json (e.g. `notified_at` updated on success — same pattern as today's submission notification).

If the email send fails: the priced-writeback still returns `200`. A lost notification is recoverable (customer can visit the status link; operator can resend from admin); a 500 on the writeback would leave ABERP retrying forever. Per the existing posture in `email.ts:222`: "best-effort, never blocks the response."

### `quoting` intermediate state

The poll daemon writes `POST /api/quotes/{id}/status { status: "quoting", notes: "ABERP pulled CAD at <ts>" }` **on CAD pull start**. This drives the customer status page's `quoting` chip (HU: "Árazás folyamatban"). Per `[[trust-code-not-operator]]`, the customer should see real progress, not a frozen "received" while ABERP processes for 90 seconds.

The state machine permits `received → quoting → quoted` and idempotent `quoting → quoting` (re-pull on retry, no-op). A `quoting → received` regression is rejected with 409.

## Alternatives considered

### A — JSON-only writeback, PDF as base64 string

Body: `{ meta: {…}, pdf_base64: "JVBE…" }`.

**Rejected.** Base64 inflates the wire by 33% (a 200 KB PDF becomes 270 KB on the wire). Multipart is the right shape for "structured metadata + opaque blob." Node's `request.formData()` handles it natively.

### B — Two separate POSTs: meta first, PDF second

`POST /api/quotes/{id}/priced` (meta) followed by `PUT /api/quotes/{id}/pdf` (blob).

**Rejected.** Two POSTs = two failure points = ambiguous half-state ("meta accepted, PDF in flight, what state is the quote in?"). The atomic transition is "this quote is now `quoted` with this breakdown and this PDF, all-or-nothing."

### C — Store PDF in object storage (S3), wire only an URL

The priced-writeback body carries an `s3://` URL; storefront fetches lazily on customer download.

**Rejected.** Adds an S3 dependency to ABERP (currently no AWS creds on Ervin's Mac — `[[spacex-vertical-integration]]` flags every dependency added). The Lightsail box has 20GB of attached block storage already mounted; PDFs at ~200KB each fit comfortably for a decade.

### D — Inline `breakdown_json` as flat fields

Surface every breakdown field (`material_cost_eur`, `setup_time_min`, …) as a top-level key the storefront can validate.

**Rejected.** Per ADR-0002, `breakdown_json` is **opaque** to the storefront — pricing internals stay in ABERP. The storefront doesn't validate, doesn't compute, doesn't drift. The PDF is what the customer sees; the JSON is for the admin debug view only.

### E — Use `POST /api/quotes/{id}/status` with a JSON-encoded `notes`

Cram everything into the existing endpoint's `notes` field, including the PDF as base64.

**Rejected** on shape grounds. Notes is a free-text human-readable field; turning it into a structured payload is a layer violation. The new endpoint is honest.

## Consequences

### Positive

- The wire contract is small, multipart-standard, and easy to call from `reqwest` (ABERP-side) and to validate in SvelteKit.
- The state-machine invariants (received → quoting → quoted; no skip; idempotent on hash match) are app-layer in TypeScript per `[[no-sql-specific]]`.
- The customer sees real progress (`quoting` chip), real artifact (PDF inline on status page), and a real accept link in their inbox.
- ABERP can retry safely on transport flake — idempotency is hash-keyed, not timestamp-keyed.

### Negative

- **5 MB cap on the PDF** is a guess. If ABERP's indicative PDF generator ever produces something larger (e.g. an embedded 3D preview), the cap needs to bump. Documented; flagged for re-evaluation in the first PR-03 cut report.
- **A failed customer email after a successful priced write** leaves the customer in the dark until they revisit the status link. Per `[[trust-code-not-operator]]`, the status link is the durable surface; the email is a notification. Acceptable.

### Neutral

- The `pricing` block in metadata.json is forward-tolerant — ABERP can add new fields (e.g. `currency: "EUR"`) and the storefront stores them verbatim.
- The PDF storage path (`priced.pdf` constant per quote dir) keeps the download route trivial — no index lookup needed.

## Validation

PR-03 integration tests:

- Happy path: POST with valid multipart → 200, metadata.json shows `status: "quoted"`, `priced.pdf` exists.
- Idempotent: same `feature_graph_hash` POSTed twice → both 200, no duplicate side effects (e.g. no double email — check `notified_at` doesn't bump twice).
- Conflict: different `feature_graph_hash` on a `quoted` quote → 409.
- Conflict: POST on an `approved` quote → 409 `terminal_or_committed`.
- Auth: no bearer → 401; wrong bearer → 401.
- Body cap: PDF > 5 MB → 413.
- Validation: malformed `valid_until` → 400; non-blake3 hash → 400.
- E2E with ABERP-shaped mock: `curl -X POST /api/quotes/<id>/priced -F meta=@meta.json -F pdf=@quote.pdf -H "Authorization: Bearer <token>"` flips state and renders PDF on status page.

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §6
- ADR-0002 — auto-quote architecture split
- Existing patterns: `src/lib/server/quote-store.ts` (atomic write), `src/routes/api/quotes/[id]/status/+server.ts` (state writeback)
