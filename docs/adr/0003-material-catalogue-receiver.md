# ADR 0003 — Material catalogue receiver (`PUT /api/catalogue/materials`)

**Status:** Accepted (2026-06-06, S276 / PR-01). Implements [ADR-0002](0002-auto-quote-architecture-split.md).
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §8.
**ABERP-side wire emitter:** `ABERP/apps/aberp/src/catalogue_push.rs` (S266, PROD_v2.26.1).

## Context

ABERP closed S266 with a daemon that PUTs the public projection of its `quoting_materials` table to the storefront every 15 minutes plus on every operator CRUD write. The wire body:

```json
{
	"materials": [
		{
			"grade": "AL_6061_T6",
			"display_name": "Aluminium 6061-T6",
			"stock_status": "in_stock",
			"lead_time_default_days": 0
		}
	]
}
```

Cost, multipliers, density, machinability index — pricing-IP fields — are **never** pushed. The push is full-snapshot replace: a grade absent from the body has been deleted. The bearer is the SPOC quote-intake token (== storefront's `ABERP_SITE_ADMIN_TOKEN`). On 401 the ABERP daemon pauses sticky until next `aberp serve` boot; transient errors back off 5s → 15s → 60s → cadence.

The storefront has no receiver yet. The `/quote` form's material dropdown today is a hard-coded six-option `<select>` in [`src/routes/quote/+page.svelte:279`](../../src/routes/quote/+page.svelte). Customers see "Aluminum/Steel/Stainless/Brass/Plastic/Other" — nothing aligned to the grades ABERP actually catalogues (MONEL_650, TI_6AL_4V, INCONEL_718, etc., per `[[aberp-auto-quoting]]`).

## Decision

Two new endpoints land in PR-02:

### `PUT /api/catalogue/materials` — receiver (Bearer-authenticated)

- Auth: `requireAdminAuth(request)` — the existing bearer check on `ABERP_SITE_ADMIN_TOKEN`. **No new secret.**
- Validation: each material row must have `grade` matching `/^[A-Z][A-Z0-9_]*$/` (max 64 chars), non-empty `display_name` (max 200, header-injection-safe), `stock_status` in the closed enum `{in_stock, source_1_2d, source_3_7d, source_2_4w, special_order}`, `lead_time_default_days` non-negative integer ≤ 365.
- One bad row rejects the entire snapshot with `400` — ABERP treats the PUT as atomic; partial replace would diverge the two sides' snapshots.
- On success: atomic write of the body to `/data/catalogue/materials.json` (tmpfile + rename), return `200 { "received_count": N }`.
- Body cap: 1 MB. ABERP's catalogue is ≤ ~50 entries; 1 MB is comfortable.
- 401 on bad bearer (today's `requireAdminAuth` helper); 413 over cap; 503 if `ABERP_SITE_ADMIN_TOKEN` unset (today's refuse-to-serve posture).

### `GET /api/catalogue/materials` — public reader (no auth)

- Returns the cached snapshot with a `received_at` timestamp:
  ```json
  { "materials": [ … ], "received_at": "2026-06-06T18:00:00Z" }
  ```
- Empty body `{ "materials": [] }` when no PUT has been received yet (first boot).
- Cache headers: `Cache-Control: public, max-age=60` — the `/quote` page can hydrate a stale-but-fresh-enough catalogue.

### Storefront `/quote` form changes

- The dropdown **adds** a fetch of `/api/catalogue/materials` at hydration time and renders the grade list when the cache is populated. The hard-coded `<option>` list is **preserved as the fallback** (see next bullet), so the existing markup is widened, not replaced.
- **Fallback when the catalogue is empty** (first boot, ABERP never connected yet): show the existing six-option hard-coded list with a small note. The form must never become unusable because the catalogue cache is cold (`[[trust-code-not-operator]]`).
- The form posts `material=<grade>` once the catalogue is populated. The existing `ALLOWED_MATERIALS` Set in `/api/quote/+server.ts` is **widened** to accept either a legacy preference (`aluminum`/`steel`/...) OR a grade that exists in the current catalogue snapshot. The legacy values stay valid forever — no breaking change to any pre-PR-02 customer with a stale tab open.

## Alternatives considered

### A — Pull from ABERP instead of receive a push

`GET https://aberp.local/catalogue/materials` from the storefront on each `/quote` hit (or on a schedule).

**Rejected.** ABERP has no public inbound surface (`[[aberp-site-ssr-live]]`, ABERP-side §1, ADR-0057). The architecture invariant is "everything flows ABERP → storefront on a poll/push; nothing calls into ABERP." Reversing it would mean punching a hole in the desktop's network posture for one endpoint. Not worth it.

### B — Single endpoint with Bearer-or-public via method

`PUT` (Bearer) and `GET` (public) on the same path, today's decision.

### C — Two separate paths (`/api/catalogue/materials/admin` for PUT, `/api/catalogue/materials` for GET)

**Rejected.** REST hygiene: same resource, different methods. The Bearer gate is per-method already.

### D — Validate `grade` against the current snapshot on `POST /api/quote`

The form posts `grade=AL_6061_T6`; the API checks the value exists in `/data/catalogue/materials.json`.

**Adopted as a soft-validation step** — only when a non-legacy grade is posted. A grade that _was_ in the catalogue at submit-time but has since been removed is still accepted (ABERP will reject downstream if it can't price). Per `[[trust-code-not-operator]]`, we don't punish the customer for a race.

### E — Sign the catalogue payload (HMAC body)

**Rejected.** The Bearer-authenticated TLS transport is already authenticated. Adding HMAC over the body is belt-and-suspenders without a threat that motivates it (the bearer is the SPOC; if it's compromised, body HMAC doesn't save us).

## Consequences

### Positive

- The customer sees real grades on the form. Quote requests carry meaningful material info into ABERP. Operator no longer mentally maps "aluminum" → "is this 6061 or 7075?"
- ABERP's catalogue CRUD (S266 SPA) becomes the single source of truth for the customer dropdown. One write, one place. Per `[[hulye-biztos]]`.
- No new secret to manage. SPOC bearer reuse holds.

### Negative

- **Stale-cache window** of up to 15 minutes (ABERP's cadence) between an operator change and the dropdown reflecting it. The on-write trigger makes most cases instant, but a CDN edge cache or a customer keeping the page open spans that gap.
- **Validation coupling.** The `stock_status` enum must stay in sync with ABERP's. Documented in this ADR; future ABERP-side additions land as a forward-compat receiver change (the storefront simply rejects unknown values with a 400 until updated).

### Neutral

- Catalogue JSON on disk is durable. A box reboot serves the last-pushed catalogue immediately on next boot.
- The cache file's `received_at` field gives operators a "last sync" sanity surface in `/admin`. PR-05 adds the read-only display.

## Validation

PR-02 integration tests:

- `PUT` with valid body → 200, file written, GET returns the body.
- `PUT` with one bad row → 400, file untouched.
- `PUT` without bearer → 401.
- `PUT` with body > 1 MB → 413.
- `GET` empty → `{ materials: [] }`.
- `GET` after `PUT` → returns the PUT'd body + `received_at`.
- E2E: ABERP-side mock daemon PUTs a 3-row catalogue; storefront `/quote` dropdown shows 3 options.

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §8
- ABERP-side push impl — `ABERP/apps/aberp/src/catalogue_push.rs`
- ABERP-side public projection — `crates/aberp-quote-engine`... actually `ABERP/apps/aberp/src/quoting_materials.rs` (`list_public`)
- Existing storefront patterns — `src/lib/server/auth.ts` (Bearer helper), `src/lib/server/quote-store.ts` (atomic-write pattern)
