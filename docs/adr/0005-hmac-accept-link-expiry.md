# ADR 0005 — HMAC accept link with 30-day expiry

**Status:** Accepted (2026-06-06, S276 / PR-01). Extends PR-L's `quote-token.ts`.
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §7.
**ABERP-side commitment:** ABERP-side ground-zero §12, pushback M (30-day expiry, no portal v1).

## Context

PR-L shipped `signQuoteToken(id) = HMAC-SHA256(id, QUOTE_STATUS_SIGNING_KEY)` and the route `/q/{id}?t=<token>` for read-only customer status access. The token has **no expiry** encoded — its lifetime is bounded only by key rotation.

That posture is fine for a read-only status link: the worst case of an old token leaking is a stranger sees the status of a stale quote.

It is **not** fine for the new accept link from PR-04. An accept-click is a commercial commitment; an indefinite-validity token is a liability. The ABERP-side design (`[[aberp-quoting-design-addenda]]` parent doc, §12) and the EVE spec both commit to 30-day expiry. This ADR makes that real on the storefront.

## Decision

Two distinct token shapes coexist in `src/lib/server/quote-token.ts`, both base64url-encoded HMAC-SHA256:

### Status token (the existing PR-L shape, preserved)

- **Material signed:** `HMAC-SHA256(id ‖ "status", secret)`.
- **Used for:** `/q/{id}?t=<token>` and `/api/quotes/{id}/pdf?t=<token>`.
- **Expiry:** none. Kill switch is `QUOTE_STATUS_SIGNING_KEY` rotation (today's behavior preserved).
- **Wire format:** `?t=<token>`. Same as today.
- **Domain marker `"status"` is added under a forward-compat scheme**: PR-04 generates new tokens with the `"status"` marker mixed into the HMAC; the verifier accepts BOTH the new shape AND the legacy-no-marker shape for a transition window. Existing PR-L links keep working. The legacy-acceptance path is removed in a follow-up PR (PR-06+) once enough time has passed.

### Accept token (new, PR-04)

- **Material signed:** `HMAC-SHA256(id ‖ "accept" ‖ expiry_iso, secret)`.
- **Used for:** `/q/{id}/accept?ts=<expiry_iso>&sig=<token>` (GET landing) and `POST /q/{id}/accept` (single-use commit).
- **Expiry:** 30 days from issue. `expiry_iso` is the ISO-8601 string `YYYY-MM-DDTHH:MM:SS.000Z`, baked into the URL and into the HMAC input.
- **Wire format:** `?ts=<expiry_iso>&sig=<token>`. Two query params, both required.

### Why two domains in the HMAC input

Domain separation — the literal `"status"` / `"accept"` strings mixed into the HMAC — prevents a status-link signature from being replayed as an accept-link signature (and vice versa) even if an attacker captures one of each. Standard pattern; no exotic crypto.

### Why expiry in the URL AND in the HMAC input

Two reasons:

1. **The HMAC input must include the expiry** — otherwise an attacker can extend the URL's expiry by editing the `ts` param, and the signature would still verify (since the signature doesn't know what the URL said).
2. **The expiry must be visible to the verifier** — it can't be implicit, since "issued at X, expires X+30d" needs the `X` to come from somewhere reproducible. The cleanest source is the URL itself.

### Verification order

Server-side check on the accept landing:

```
1. Parse `ts` and `sig` from the URL.
2. Recompute HMAC over (id, "accept", ts) with the secret.
3. Constant-time compare against `sig` (timingSafeEqual on equal-length buffers).
4. If mismatch → 403, regardless of whether ts is in the past.
5. If match → check ts > now() → if not, 403 "expired."
6. If both pass → render the accept-confirm page.
```

Doing the HMAC check **before** the expiry check is intentional — a wrong signature should return 403 regardless of expiry. A probe that could distinguish "valid signature but expired" from "invalid signature" would leak which expiries were ever issued.

### Single-use enforcement

After the customer POSTs the accept commit:

- The state-machine invariant in [`src/lib/server/quote-status.ts`](../../src/lib/server/quote-status.ts) is extended: `quoted → approved` is the only valid transition into `approved`, and it requires the HMAC token to be present and valid.
- A second POST on the same quote (even with a valid still-non-expired token) returns `409 { "error": "already_accepted" }` because the precondition `quote.status === "quoted"` no longer holds.
- The customer-facing surface renders 409 as a friendly "this quote is already accepted; our team is preparing your order" page — not a raw HTTP error.

### Secret storage

`QUOTE_STATUS_SIGNING_KEY` env var (today's name preserved — reused for both token types). Lives in `/etc/aberp-site.env` on the Lightsail box, chmod 600, chown aberp:aberp. Rotation invalidates **every** issued link (both status and accept) at once — the global kill switch.

**Same secret for both token shapes** because:

- The domain separation in the HMAC input (`"status"` vs `"accept"`) is sufficient to prevent cross-domain replay.
- Two secrets would double the rotation surface for no security gain.
- The `[[hulye-biztos]]` posture: one knob to rotate, one place to audit.

## Alternatives considered

### A — Per-quote one-time random token stored on disk

Generate a UUID at priced-writeback time, persist in metadata.json, hand it to the customer in the email. Verify by table lookup.

**Rejected.** Persisted tokens need a revocation table, an expiry sweep, and a state-machine for "issued/used/expired/revoked." HMAC-with-baked-expiry is stateless: the token is its own truth.

### B — JWT with `exp` claim

Standard JWT (signed with HS256), `exp` claim for expiry.

**Rejected on shape grounds.** JWT adds JSON parsing, claim validation, and a library dependency for the same security we get from raw HMAC + a query param. The existing `quote-token.ts` is 45 lines and audit-clean. JWT here would be over-engineering.

### C — Short expiry (24h)

24-hour token, customer must accept "today" or get a fresh link emailed.

**Rejected.** A two-business-day SLA already implies a customer may take days to decide. 30-day expiry matches the indicative quote's typical validity window (and is the ABERP-side design commitment, §12). If a customer waits > 30d, ABERP regenerates a fresh indicative (new quote_id, new link) per the design's regeneration-mints-new-id invariant.

### D — Long expiry (90d or "until valid_until")

Bind the accept-link expiry to the quote's own `valid_until`.

**Considered.** It's logically clean: "the link lives as long as the quote is valid." But it conflates two different things:

- `valid_until` is the **price** validity (catalogue can drift after this).
- accept-link expiry is the **link** validity (security freshness).

Decoupling them is cleaner: the price can expire before the link does (banner appears, customer can still click), or the link can expire before the price does (we re-issue). 30d as a fixed value is honest about the link's security half-life, not coupled to pricing.

### E — Two secrets (status-key + accept-key)

Separate signing keys per token shape.

**Rejected.** Domain separation in the HMAC input gives the same property at half the operational surface.

## Consequences

### Positive

- Customer accept links have a defined security half-life (30d). Stale links 403 cleanly.
- The status link's no-expiry behavior is preserved — today's email links keep working.
- The verifier is short, stateless, and side-effect-free. Audit-clean.
- One secret to rotate.

### Negative

- **The 30d clock starts at link-issue time, not at customer-receipt time.** A customer who fishes a 29-day-old email out of spam has only one day. Mitigated by the "expiring soon" reminder email (out of scope v1, design doc §9, flagged as open Q in the design doc).
- **Legacy status tokens (pre-PR-04) work under the dual-acceptance scheme.** Removal of the legacy-no-marker path is a follow-up. Until that PR ships, an attacker who held a pre-PR-04 status token might still use it on the post-PR-04 surface. Status-only access; not a commitment surface; acceptable.

### Neutral

- The accept route is two-step (GET landing + POST commit), so the HMAC check runs twice — once on landing, once on commit. Both must pass; this is deliberate (the landing acts as a freshness gate before showing the customer the confirm UI).

## Validation

PR-04 unit tests:

- `signAcceptToken(id, expiryIso)` is deterministic — same inputs → same output.
- `verifyAcceptToken(id, expiryIso, token)` accepts a fresh token (`expiryIso` future).
- Tampered `expiryIso` → false.
- Tampered `id` → false.
- Tampered `token` → false.
- Expired `expiryIso` → THE FUNCTION STILL RETURNS TRUE on signature match (expiry check is a separate step in the verifier — see "Verification order" above). The route-level handler is what 403s on the expired ts.
- Domain confusion: a status-token presented as accept-token → false (different `"status"` vs `"accept"` material).
- Constant-time: the timingSafeEqual path doesn't short-circuit on first-byte mismatch (already true in today's `verifyQuoteToken`).

PR-04 integration tests:

- `GET /q/{id}/accept?ts=<future>&sig=<valid>` → 200 renders confirm page.
- `GET /q/{id}/accept?ts=<past>&sig=<valid>` → 403 expired.
- `GET /q/{id}/accept?ts=<future>&sig=<bad>` → 403 invalid.
- `POST /q/{id}/accept` (valid) on `quoted` quote → 303 redirect to status page, state flips to `approved`.
- `POST /q/{id}/accept` (valid) on already-`approved` quote → 409.

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §7
- Existing token impl — [`src/lib/server/quote-token.ts`](../../src/lib/server/quote-token.ts)
- ABERP-side §12 (30-day expiry commitment) — `ABERP/docs/design/auto-quoting-ground-zero.md`
- PR-L brief & implementation — `git log --grep="PR-L"`
