# ADR 0002 — Auto-quote architecture split: engine in ABERP, storefront thin

**Status:** Accepted (2026-06-06, S276 / PR-01).
**Design doc:** [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md) §2.
**Companion (ABERP-side):** `ABERP/docs/design/auto-quoting-ground-zero.md` §14-D.

## Context

ABERP closed S266–S275 at `PROD_v2.26.1`, shipping the full producer-side auto-quoting pipeline: pure-Rust scoring engine (`crates/aberp-quote-engine`), Python CAD extractor with its Rust wrapper (`crates/aberp-cad-extract-wrapper` + `python/aberp-cad-extract`), DuckDB-backed catalogue (`quoting_materials` + 7 other tables), DEAL saga (ADR-0067 ABERP-side), material reservations (ADR-0069 ABERP-side), `stock_alert` sticky-flag enforcement, and the audit ledger entries for the whole flow.

The storefront-side counterpart now needs to be designed. Three architectural splits between ABERP and storefront are tenable:

- **A** — pure storefront pipeline (storefront does CAD extract + scoring; ABERP polls finished quotes).
- **B** — storefront stages, ABERP processes, ABERP writes back priced quote.
- **C** — hybrid (storefront extracts CAD JSON, ABERP scores).

The ABERP-side ground-zero doc §14-D already named option B ("Quote engine runs in ABERP, not on the storefront") as the right shape. This ADR pins that decision on the _storefront_ side with its own analysis.

## Decision

**Option B.** The storefront is a thin **stage + expose + accept** surface. The CAD extract and scoring engine run **in ABERP**, which polls the storefront, pulls the CAD blob, prices, and writes back the priced artifact + PDF.

Concretely on the storefront side:

- **Persist** the customer's submission (today's `POST /api/quote` path, unchanged).
- **Expose** `GET /api/quotes?status=…` and `GET /api/quotes/{id}/files/{name}` for ABERP to poll (today's contract, unchanged).
- **Receive** the priced quote via a new `POST /api/quotes/{id}/priced` (multipart: JSON breakdown + PDF blob).
- **Re-render** the customer's status page `/q/{id}?t=<token>` to show the priced PDF and (per addendum 2) the `stock_alert` banner.
- **Accept** via a new HMAC-signed `/q/{id}/accept?ts=<expiry>&sig=<sig>` landing.
- **Writeback** the state to `approved` so ABERP's next poll can drive the DEAL saga.

The storefront never sees the FeatureGraph, never sees pricing internals (cost, multipliers, density, machinability — all stay in ABERP per the ABERP catalogue-push `PublicMaterial` projection), and never holds the audit ledger. Its `breakdown_json` field is **opaque** — stored verbatim, displayed in the customer PDF, never inspected.

## Alternatives considered

### A — Pure storefront pipeline

Storefront calls a Python CAD subprocess plus an embedded scoring engine (TypeScript port or WASM build of `aberp-quote-engine`). ABERP polls only finished quotes for downstream WO/invoice plumbing.

**Rejected** for three load-bearing reasons:

1. **Duplication.** The Rust scoring engine exists with property tests. A TypeScript port will drift the first time a multiplier is tweaked on one side. A WASM build adds toolchain weight and a per-request startup tax. Either way, two source-of-truth for pricing math violates `[[trust-code-not-operator]]`.
2. **IP leak.** The catalogue cost fields (cost_per_kg, multipliers, machinability_index) live in ABERP's DuckDB and are explicitly **not** pushed to the storefront (the ABERP-side `PublicMaterial` projection is grade + display_name + stock_status + lead_time_default_days only). Pricing on the storefront either requires replicating these fields publicly (rejected on IP grounds) or RPC-ing back to ABERP for each price (which is option B with extra steps).
3. **Partner-scoped margin profiles.** Margin profiles live on `partners.quoting_margin_profile_id` (ABERP-side §11 pushback K). The storefront doesn't know about partners. Pricing without the right margin is wrong; pricing with it requires a partner-sync seam — a multi-PR sink for no architectural gain.

Operational additions that worsened the verdict: a Python venv on the Lightsail Nano (already needs 2GB swap to survive `npm ci`, per `[[aberp-site-ssr-live]]`), heavy OCP/build123d wheels on a public-facing box.

### C — Hybrid: storefront extracts CAD, ABERP scores

Storefront runs a thin CAD extractor (Python subprocess) and pushes the FeatureGraph JSON to ABERP. ABERP polls the JSON (no blob pull) and scores.

**Rejected** for two reasons:

1. **Two coordination seams instead of one.** Storefront → ABERP (FeatureGraph push) plus ABERP → storefront (priced-writeback). Two contracts to version, two auth flows, two retry policies. The blast radius of a contract drift doubles.
2. **CAD-extract crash blast radius on the public surface.** A malformed STEP that segfaults the Python subprocess takes down a route customers see. The Rust subprocess wrapper (`aberp-cad-extract-wrapper`) was built specifically to _isolate_ the Python crash domain via timeout + memory cap + schema validation. Moving the extract to the storefront throws away that blast door for a small latency win (instant geometric stats on the confirmation page) that customers don't care about.

### B — Storefront thin, ABERP processes (the pick)

Pros that decided it:

- **Zero duplication.** Engine, catalogue, params, margin profiles, audit, DEAL — all stay where they already are.
- **Single source of truth for pricing.** The Rust crate is it.
- **The wire contract is a superset of the existing S256/S266 quote-intake.** Same `GET /api/quotes?status=…`, same bearer, same `POST /api/quotes/{id}/status`. One new method (`POST /api/quotes/{id}/priced`) and one new push receiver (`PUT /api/catalogue/materials`, already shipped on ABERP's side as `catalogue_push.rs`).
- **Latency is acceptable.** Worst-case ABERP-poll-cadence (60s) + extract + writeback ≈ 60-180s. Customer-facing SLA copy is already "two business days"; we tighten to "usually within a few minutes."

Cons that did **not** decide against it:

- Requires ABERP to be online for pricing to advance. Mitigated by the SLA copy.
- Extra POST per quote per cycle. Trivial at expected v1 volume.

## Consequences

### Positive

- The Rust scoring engine, audit ledger, DEAL saga, and catalogue stay single-instance. No drift, no duplicate test surface.
- The storefront's existing strengths (Origin allowlist, content-sniff, honeypot, rate-limited email) keep being load-bearing where they already are.
- A future "operator does not own a desktop" (SaaS migration, `[[aberp-saas-migration]]`) does not change this seam — ABERP becomes a different deployment shape, but the storefront still calls the same wire surface from the still-thin role.
- The contract between the two sides is small enough to test end-to-end (the §11 walkthrough).

### Negative

- **ABERP must be running for pricing to advance.** If Ervin's Mac is off, quotes stack in `received` until it boots. Documented in the customer-facing copy.
- **Two repos to coordinate** on contract changes. Mitigated by ABERP's forward-tolerant parser (`#[serde(flatten)]` everywhere on the wire types) and the storefront's TypeScript wire-shape pinned in `quote-store.ts`.

### Neutral

- The storefront's filesystem JSON persistence (today's `metadata.json` per quote dir) is sufficient. No DB needed on this side per `[[no-sql-specific]]`.
- The `ABERP_SITE_ADMIN_TOKEN` does double-duty as the SPOC bearer — both `/admin/*` and the ABERP-driven `/api/quotes*` + `/api/catalogue/*` writes are gated by it.

## Validation

The architecture is end-to-end-validated by the §11 walkthrough in the design doc — Ervin runs one form submission and confirms the full pipeline lands a customer in `invoiced` state. Pre-walkthrough validation:

- `npm run check` + `npm run lint` + `npm run build` clean on PR-02..PR-05 individually.
- Per-PR integration tests (priced-writeback golden, HMAC sign/verify with expiry, single-use accept, addendum-2 banner, addendum-3 accept UX).
- A round-trip test where a hand-written `curl -X POST /api/quotes/<id>/priced` mock (ABERP-shaped multipart) flips the test quote into `quoted` and the customer status page renders correctly.

## References

- Design doc — [`docs/design/storefront-auto-quote-pipeline.md`](../design/storefront-auto-quote-pipeline.md)
- ABERP-side ground-zero — `ABERP/docs/design/auto-quoting-ground-zero.md`
- ABERP catalogue push implementation — `ABERP/apps/aberp/src/catalogue_push.rs`
- ABERP quote-intake daemon — `ABERP/crates/aberp-quote-intake/src/service.rs`
- ABERP-side ADRs: ADR-0057 (quote-intake architecture), ADR-0066 (quote-engine architecture), ADR-0067 (DEAL saga atomicity)
