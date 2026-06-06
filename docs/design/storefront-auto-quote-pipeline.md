# Storefront-Side Auto-Quote Pipeline — Ground-Zero Design

**Status:** Draft v0 — design only, **no code**. Session 276 / PR-01.
**Base commit:** `291d900` (S253-S254 hardening: CloudFront `/api/*` pass-through, Origin allowlist, fail-closed `publicSiteUrl()`).
**Author session:** S276.
**Companion ADRs (filed in this PR):**

- [ADR-0002 — Auto-quote architecture split: engine in ABERP, storefront thin](../adr/0002-auto-quote-architecture-split.md)
- [ADR-0003 — Material catalogue receiver (`PUT /api/catalogue/materials`)](../adr/0003-material-catalogue-receiver.md)
- [ADR-0004 — Priced-quote writeback contract](../adr/0004-priced-quote-writeback.md)
- [ADR-0005 — HMAC accept link with 30-day expiry](../adr/0005-hmac-accept-link-expiry.md)
- [ADR-0006 — Local SMTP send (no internal email-relay endpoint)](../adr/0006-local-smtp-send-no-relay.md)

**Sibling doc (the producer side):** [`ABERP/docs/design/auto-quoting-ground-zero.md`](../../../ABERP/docs/design/auto-quoting-ground-zero.md). The ABERP-side design closed S266–S275 at `PROD_v2.26.1` (DEAL saga, sticky `stock_alert`, material commit + sweep). This doc is the **storefront-side counterpart** — what the customer-facing layer has to be so the ABERP polling daemon and outbound push can drive end-to-end auto-quoting.

This doc ships zero product code. The deliverables PR-02 through PR-05 (roughly four storefront sessions) implement against it. Every default chosen here is reversible by Ervin with a sentence; where a choice is non-obvious, it is flagged inline with the reasoning rather than asked as a blocking question (per `[[no-ask-user-question]]`).

It is written **adversarially against the originating brief** per `[[pushback-as-method]]`. Two of the brief's premises do not survive contact with the committed ABERP-side architecture (§14-D of the ABERP doc) and one storefront-side runtime fact (PR-K landed local SMTP, S232 era); those are corrected in §9 and §12 with the better path.

---

## 1. Executive summary

**Architecture pick: Option B.** Storefront stages the customer's CAD submission, exposes a polling surface, and re-renders a customer-facing "your quote is ready / accept here" path. **The CAD extract + scoring engine runs on ABERP**, which polls the storefront, pulls the CAD, prices, and writes back. The storefront ships zero CAD code and zero pricing code.

**Why B.** ABERP already owns the scoring engine, the FeatureGraph schema, the catalogue tables, the margin profiles, the DEAL saga, and the audit ledger — all of which closed at `PROD_v2.26.1`. Duplicating any of that into the storefront violates `[[trust-code-not-operator]]` (one source of truth) and `[[no-sql-specific]]` (invariants in app layer, not scattered across two stacks). The ABERP-side ground-zero doc §14-D ("Quote engine runs in ABERP, not on the storefront") has already pinned this; this storefront doc is what that pin requires of _this_ side.

Full A/B/C analysis lives in §2 and ADR-0002. Storefront's job is: **stage, expose, re-render, accept** — not price.

---

## 2. Architecture decision — full A/B/C with pushback

Three viable splits between storefront and ABERP. Each is genuinely tenable; the pick is about _where the gravity lives_, not which works.

### Option A — Pure storefront pipeline

Storefront calls a Python CAD subprocess + an embedded scoring engine (TypeScript port? WASM? subprocess into a Rust binary?). All extraction and pricing on the Lightsail box. ABERP polls only finished quotes for downstream WO/invoice plumbing.

**Pros**

- Single data-flow direction (storefront → customer), tight feedback loop on the customer-facing surface — no round-trip to a desktop app that may be offline.
- The polling-daemon contract stays as it is today (S256 era): storefront publishes `approved` quotes; ABERP picks them up. Auto-quoting becomes invisible to ABERP except as "pre-priced approved quotes."
- Customer never waits for an offline desktop app. SLA story is simpler.

**Cons**

- The Rust scoring engine (`crates/aberp-quote-engine`) exists, has property tests, and closed at S268. A TypeScript port is a duplicate codebase that will drift the first time someone tweaks a multiplier on one side. A WASM build adds toolchain weight to the storefront's deploy and pays a startup tax on every `/api/quote` request. A subprocess-to-Rust-binary on the Lightsail Nano box pays the cost of a second build artifact + a deploy lane for it.
- Python CAD venv on the Lightsail box: realistic but new burden. The bootstrap walkthrough already documented 6 hand-fixes Ervin had to make (`[[aberp-site-ssr-live]]`); adding `pythonOCC` / `build123d` would double that surface. The Nano instance ran out of RAM during `npm ci` and needed 2 GB swap; OCP wheels are heavy.
- The catalogue (materials, machines, params, margin profiles, partner master-data) lives in ABERP's DuckDB. To price on the storefront, we'd either replicate the _cost-bearing_ fields (cost_per_kg, multipliers — which the ABERP design §11 explicitly says NEVER push to the storefront) or shell back to ABERP for each price. The first leaks pricing IP into a public-facing surface; the second is just option B with extra steps.
- Margin profiles are partner-scoped (`partners.quoting_margin_profile_id`, ABERP design §11 pushback K). The storefront doesn't know about partners. Pricing without margin profile is wrong; pricing with it requires partner sync; partner sync is its own multi-PR problem.
- The DEAL saga, material reservation, audit ledger, stock_alert detection are all ABERP-side. The storefront would still hand off most of the work — so the "pure storefront pipeline" really means "pure storefront pipeline + 80% of the existing handoff," which is the worst of both shapes.

**Verdict:** rejected on duplication + IP-leak grounds. Tenable only if ABERP did not already own the engine.

### Option B — Storefront stages, ABERP processes, ABERP writes back

Storefront receives the CAD submission, persists, exposes `GET /api/quotes?status=received`. ABERP polls, pulls the CAD blob, extracts geometry, prices, generates indicative PDF, and **writes back to the storefront** via `POST /api/quotes/{id}/priced` with the breakdown + PDF blob. Storefront stores the priced artifact, emails the customer (`SMTP_*` env, the locally-configured ABERP SPOC creds per `[[aberp-smtp-spoc]]`), surfaces a customer-facing status page. On accept-click (HMAC-validated), storefront flips state and the next ABERP poll picks it up to feed the DEAL saga.

**Pros**

- **Zero duplication.** Engine, catalogue, params, margin profiles, audit, DEAL — all stay where they already are. The storefront learns _nothing_ about pricing internals.
- **Single source of truth for pricing logic** is the existing Rust `aberp-quote-engine` crate. Same change → same behavior, no drift.
- The polling-daemon contract is a **superset** of S256/S266 — same shape (`GET /api/quotes?status=`, bearer auth, status writeback), one new method (priced-writeback POST). The existing transport, audit, backoff, pause-on-401 all extend straight through.
- Catalogue push (S266 / `catalogue_push.rs`) is already shipped on the ABERP side; the storefront just needs the receiver. The public projection (grade, display*name, stock_status, lead_time_default_days) is the \_only* catalogue knowledge that ever crosses the wire — cost, multipliers, density, machining factors stay in ABERP.
- DEAL saga lands on confirmed `accepted` quotes via the existing intake path. No new ABERP-side plumbing needed beyond what `PROD_v2.26.1` shipped.
- Local SMTP send on the storefront is already wired (PR-K, `src/lib/server/email.ts`). The customer email send path doesn't need a relay endpoint.

**Cons**

- **Round-trip latency.** Customer submits, ABERP polls (default 60s cadence), ABERP pulls + extracts + prices, ABERP writes back, storefront emails customer. Worst-case ≈ poll-cadence + extract time + writeback latency ≈ 60-180 s. Customer sees "your quote is being priced — usually within a few minutes" between submit and the priced email.
- **Requires ABERP to be running** for pricing to advance. If Ervin is on holiday and the desktop is off, customers' quotes pile up in `received` and nothing happens until ABERP boots. **Acceptable** — customer-facing SLA is already "two business days" (per the existing /quote form copy); 12-24h of ABERP-offline is inside the SLA. We honestly tell the customer "usually within a few minutes; up to two business days if we're between batches."
- **Two writes per quote per cycle** instead of one (priced-writeback POST adds one POST per quote per cycle). Negligible at expected volume (single-digit quotes/day in v1).

**Verdict:** **PICKED.** This is the shape `[[trust-code-not-operator]]` + `[[no-sql-specific]]` + the ABERP-side §14-D commitment all point to. Pin in ADR-0002.

### Option C — Hybrid: storefront extracts CAD, ABERP scores

Storefront runs a thin CAD extractor (cheap geometry parse → JSON FeatureGraph). ABERP polls and consumes the JSON (no blob pull needed), scores, writes back priced quote. Two POSTs to coordinate.

**Pros**

- CAD extract can complete even if ABERP is offline; the storefront can show the customer geometric stats (bounding box, volume, hole count) on the confirmation page immediately.
- ABERP receives a pre-parsed JSON, avoids the 50 MB blob pull on every poll, faster cycle.
- Plays to the storefront's strength as the customer-facing latency surface.

**Cons**

- **Splits the CAD-extract pipeline across two languages and two repos.** The Python `aberp-cad-extract` would have to be either ported to Node (huge — the OCP/build123d kernel doesn't exist outside Python in any sane form) or invoked via subprocess on the Lightsail box (same Python-venv-on-Nano problem as Option A, with extra wire serialization).
- Two coordination seams instead of one: storefront pushes FeatureGraph to ABERP; ABERP pushes priced quote back to storefront. Two contracts to version, two HMAC/auth flows, two retry policies.
- The CAD-extract crash blast radius now lives on the public-facing surface. A malformed STEP file that segfaults the Python subprocess takes down a route the customer sees, not a daemon Ervin can restart. The Rust subprocess wrapper (`aberp-cad-extract-wrapper` — sandbox, timeout, schema validation) was built specifically to _isolate_ this; moving the extract to the storefront throws away that blast door.
- The "instant stats on the confirmation page" UX win is largely theoretical. Customers don't shop for geometric stats; they shop for a price and a date. The extract has no value to them until it produces a quote.

**Verdict:** rejected on complexity/blast-radius grounds. The latency win is real but small; the architectural cost is large.

---

## 3. Customer-facing flow

The flow the customer sees, with state-tags noting what's happening underneath.

```
 1. Customer            Lands on https://abenerp.com/quote, fills the form
                        (name, email, optional company, material from the dropdown
                        — now ABERP-catalogue-fed, see §8 — quantity, deadline,
                        notes, CAD files), submits.

                        Storefront persists to /data/quotes/<id>/ as today.
                        State: received.

 2. Confirmation page   Storefront responds with:
                        "Thanks — we have your request. Reference: <id>.
                         We'll email you with pricing, usually within a few
                         minutes (up to two business days if we're between
                         batches)."

                        Customer also receives an immediate confirmation email
                        with the signed status link /q/<id>?t=<token>
                        (today's PR-L email — unchanged).

 3. ABERP picks it up   Next ABERP poll cycle (default 60s):
                          - GET /api/quotes?status=received
                          - For each new id: GET /api/quotes/<id> (metadata)
                          - For each CAD file: GET /api/quotes/<id>/files/<name>
                          - encrypt-at-rest into ABERP blob store (ADR-0014)
                          - aberp-cad-extract → FeatureGraph
                          - aberp-quote-engine(FeatureGraph, snapshot, params,
                            margin_profile=new) → QuoteBreakdown
                          - render indicative PDF
                          - POST /api/quotes/<id>/priced
                              { breakdown_json, valid_until, pdf_blob (base64
                                or multipart), stock_alert: bool }

                        State on storefront flips: received → quoted.

 4. Storefront emails   On the priced-writeback POST, storefront sends the
                        customer the "your quote is ready" email with the
                        HMAC accept link /q/<id>/accept?ts=<expiry>&sig=<...>.

                        The customer's existing /q/<id>?t=<...> status link
                        now shows the priced PDF inline + a "pricing pending"
                        → "priced — open accept link" indicator.

 5. Customer accepts    Customer clicks the accept link.
                        Storefront validates HMAC (id ‖ expiry, secret, expiry
                        not in the past), shows the customer accept-confirm
                        page (big/loud per addendum 3 analog, single-use).
                        Customer types/clicks "Accept" → state flips to
                        approved.

                        Single-use enforcement: a replayed accept on an already-
                        approved quote returns 409 with a friendly "this quote
                        is already accepted, our team is preparing your order."

 6. ABERP picks up      Next ABERP poll cycle: GET /api/quotes?status=approved.
    accepted             ABERP's existing intake path (the S256/S266 daemon)
                        sees the approved quote with the priced breakdown,
                        runs the DEAL saga (ADR-0067, ABERP-side), reserves
                        materials, creates the Work Order, writes back
                        status=invoiced on success (today's writeback semantics
                        preserved — no change to that wire shape).

                        State: approved → invoiced.

 7. Stock alert path    Between step 4 (priced) and step 5 (accept), if ABERP
                        detects stock_alert=true on a subsequent poll's priced-
                        writeback PUT (a re-quote forced by a catalogue
                        downgrade — addendum 2 hard-blocks DEAL until operator
                        REFRESHes), the storefront flips the customer-facing
                        banner on /q/<id>?t=<...>:
                        "Stock status changed since this quote was issued —
                         pricing may be refreshed if not accepted by <date>."
                        The accept link itself is NOT blocked from the customer
                        side; the operator-side REFRESH gate (ABERP addendum 2)
                        is what enforces. Per [[trust-code-not-operator]], the
                        customer should never see a "click here to acknowledge
                        the operator's stock alert" UX.
```

### Pricing-pending indicator state — addendum 2 customer side

Per the ABERP-side design addendum 2 (sticky `stock_alert` HARD-blocks DEAL until typed REFRESH), the customer-facing surface MUST honestly show the operator-side state:

- **Status page `/q/<id>?t=<...>` (the existing PR-L surface) gains a `state` chip** — `received | quoted | approved | invoiced | rejected` per the existing `QUOTE_STATUSES` enum.
- **A new chip variant `quoting`** displays between `received` and `quoted` as a "pricing in progress, usually within a few minutes" hint. This corresponds to the ABERP daemon having pulled the CAD but not yet posted back the priced quote. Storefront knows this because the ABERP poll daemon writes back `status=quoting` on pull (a one-line addition to the existing writeback contract).
- **The `stock_alert` flag is surfaced as a banner on `/q/<id>?t=<...>`**, distinct from the chip. Pure read-only display from the customer's perspective; the actionable acknowledgment lives in the ABERP SPA per `[[trust-code-not-operator]]`.

---

## 4. Schema — storefront-side tables (filesystem JSON, today's shape extended)

The storefront's current persistence is filesystem JSON under `/data/quotes/<id>/metadata.json` (see [`src/lib/server/quote-store.ts`](../../src/lib/server/quote-store.ts)). Per `[[no-sql-specific]]` and the storefront's "thin layer" role we **keep it filesystem JSON**. No DB introduced.

### Two artifacts per quote

| File                              | Purpose                                                 | Lifecycle                                                                     |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/data/quotes/<id>/metadata.json` | The customer's submission + the priced quote (extended) | Created on `POST /api/quote`, updated on priced-writeback and on accept-click |
| `/data/quotes/<id>/files/<name>`  | Customer-uploaded CAD blobs (as today)                  | Created on submit, read by ABERP poll, never mutated                          |
| `/data/quotes/<id>/priced.pdf`    | The indicative PDF generated by ABERP                   | Created by `POST /api/quotes/<id>/priced`                                     |

### Extension to `QuoteMetadata` (TypeScript shape)

The existing `QuoteMetadata` interface (see [`src/lib/server/quote-store.ts`](../../src/lib/server/quote-store.ts)) gains an optional `pricing` sub-record. The forward-tolerant ABERP parser (`crates/aberp-quote-intake/src/payload.rs`) already accepts unknown fields via `serde(flatten)`, so this is additive — old ABERP versions ignore it cleanly.

```ts
export interface QuoteMetadata {
	// ... existing fields ...
	status: QuoteStatus; // received | quoting | quoted | approved | rejected | invoiced
	pricing?: {
		received_at: string; // ABERP wrote this priced quote at this time
		valid_until: string; // ISO date, when the indicative expires
		breakdown_json: object; // opaque-to-storefront, mirrors ABERP's calculated_breakdown_json
		pdf_stored_at: 'priced.pdf'; // relative to the quote dir
		feature_graph_hash: string; // for idempotency on re-priced writes
		extractor_version: string; // ABERP stamps this; surface in operator admin
		engine_version: string; // ditto
		stock_alert: boolean; // sticky, addendum 2 — true means "stock changed since this was priced"
	};
	accept?: {
		// populated when the customer clicks the accept link
		accepted_at: string;
		token_expires_at: string; // the expiry encoded in the HMAC at issue time
	};
}
```

**Why no `pricing_history`.** ABERP's design §10 ("regeneration mid-acceptance race") says regeneration always mints a **new quote_id** — there is no in-place mutation of a priced quote that the storefront has to track. If ABERP re-quotes, it re-quotes a new id; the storefront receives a fresh `POST /api/quotes/<new-id>/priced`. The old id's `pricing` is final until the quote is cancelled or expired.

**Why `pdf_stored_at` is a constant.** Storing the PDF at a known path lets a download route (`/api/quotes/<id>/pdf?t=<token>`) serve it without an index lookup. Idempotent re-writes (ABERP regenerates the same PDF) overwrite in place. **NOT** a security concern — the PDF is bound to a token-gated route, not directly browsable.

---

## 5. State machine

The existing storefront state machine (`src/lib/server/quote-status.ts`) is extended; no states are removed. Each transition's driver and audit row is documented.

```
                            ABERP daemon pulls CAD,
                            writes back status=quoting
                                  ↓
   ┌──────────┐  ───────►   ┌─────────┐   ──────►   ┌────────┐   ─────►   ┌──────────┐
   │ received │              │ quoting │             │ quoted │            │ approved │
   └──────────┘              └─────────┘             └────────┘            └──────────┘
        │                                                 │                      │
        │ ABERP never picked up;                          │ customer              │ ABERP DEAL saga
        │ operator marks abandoned                        │ declined or           │ created WO,
        │ in admin UI                                     │ token expired         │ writes back
        │                                                 │                      │ status=invoiced
        ▼                                                 ▼                      ▼
   ┌───────────┐                                    ┌───────────┐          ┌────────────┐
   │ rejected  │ ◄──────────────────────────────────│ rejected  │          │ invoiced   │
   └───────────┘                                    └───────────┘          └────────────┘
       (terminal)                                      (terminal)             (terminal)
```

| Transition              | Driver                                  | Authenticated by                                                   | Audit row (status_history)                                                                   |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| (none) → `received`     | Customer submit POST `/api/quote`       | Origin allowlist + honeypot + consent                              | implicit (received_at)                                                                       |
| `received` → `quoting`  | ABERP poll daemon, on CAD pull start    | Bearer `ABERP_SITE_ADMIN_TOKEN` via `POST /api/quotes/<id>/status` | `{ to: quoting, notes: "ABERP pulled CAD at <ts>" }`                                         |
| `quoting` → `quoted`    | ABERP priced-writeback                  | Bearer, via `POST /api/quotes/<id>/priced`                         | `{ to: quoted, notes: "Priced by aberp-quote-engine <ver>, valid_until <date>" }`            |
| `quoted` → `approved`   | Customer accept-link click              | HMAC token in `?sig=&ts=`                                          | `{ to: approved, notes: "Accepted by customer at <ts>" }`                                    |
| `quoted` → `rejected`   | Customer decline OR `valid_until` lapse | HMAC token OR daemon-sweep                                         | `{ to: rejected, notes: "Declined" / "Expired at <ts>" }`                                    |
| `approved` → `invoiced` | ABERP DEAL saga success writeback       | Bearer                                                             | `{ to: invoiced, notes: "ABERP draft invoice <id> created" }` — today's wire shape preserved |
| `received` → `rejected` | Operator action in `/admin/quotes`      | Cookie auth                                                        | `{ to: rejected, notes: "Operator declined" }`                                               |
| any → `rejected`        | Operator abandon                        | Cookie auth                                                        | as above                                                                                     |

**Invariants enforced in app code** (per `[[no-sql-specific]]` — these are TS-side checks, not DB CHECKs):

1. `quoting` and `quoted` are only reachable by a Bearer-authenticated POST. The customer-facing surfaces cannot drive into them.
2. `approved` is only reachable from `quoted`, and only via a valid HMAC token. The Bearer-authenticated path **cannot set `approved`** — the operator does not accept on behalf of the customer; that's a separate "operator force-accept" path (out of scope v1).
3. `invoiced` is only reachable from `approved`, and only via Bearer auth (ABERP). This mirrors today's intake-writeback contract.
4. Single-use accept: a Bearer or HMAC POST attempting to set `approved` on an already-`approved` quote returns 409.

---

## 6. Endpoints — wire surface contract

### Existing (kept as-is)

| Method | Path                            | Auth                               | Purpose                                                                                |
| ------ | ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| POST   | `/api/quote`                    | Origin allowlist + honeypot        | Customer submission (today)                                                            |
| GET    | `/api/quotes?status=<x>`        | Bearer                             | ABERP polls list (today)                                                               |
| GET    | `/api/quotes/{id}`              | Bearer                             | ABERP fetches metadata (today)                                                         |
| GET    | `/api/quotes/{id}/files/{name}` | Bearer                             | ABERP fetches one CAD blob (today)                                                     |
| POST   | `/api/quotes/{id}/status`       | Bearer                             | ABERP writes back status (today; extended to accept `quoting` + `quoted` + `invoiced`) |
| GET    | `/q/{id}?t=<sig>`               | HMAC (token-only, no expiry today) | Customer status page (today; extended per ADR-0005)                                    |

### New (this design)

| Method | Path                                   | Auth                          | Purpose                                                                |
| ------ | -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| PUT    | `/api/catalogue/materials`             | Bearer                        | ABERP pushes the public material catalogue projection (ADR-0003)       |
| GET    | `/api/catalogue/materials`             | None (public)                 | Storefront's `/quote` form reads the cached catalogue for the dropdown |
| POST   | `/api/quotes/{id}/priced`              | Bearer                        | ABERP writes back the priced quote + PDF (ADR-0004)                    |
| GET    | `/api/quotes/{id}/pdf?t=<sig>`         | HMAC                          | Customer downloads the indicative PDF                                  |
| GET    | `/q/{id}/accept?ts=<expiry>&sig=<sig>` | HMAC + expiry                 | Customer accept-confirm landing page                                   |
| POST   | `/q/{id}/accept`                       | HMAC + expiry, on form submit | Single-use accept commit, flips state to `approved`                    |

### Body shapes — new endpoints

**`PUT /api/catalogue/materials`** (full snapshot replace per `catalogue_push.rs` contract)

```json
{
	"materials": [
		{
			"grade": "AL_6061_T6",
			"display_name": "Aluminium 6061-T6",
			"stock_status": "in_stock",
			"lead_time_default_days": 0
		},
		{
			"grade": "TI_6AL_4V",
			"display_name": "Titanium Ti-6Al-4V",
			"stock_status": "source_1_2d",
			"lead_time_default_days": 2
		}
	]
}
```

**`POST /api/quotes/{id}/priced`** (multipart for the PDF blob)

```
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="meta"
Content-Type: application/json

{ "breakdown_json": { ... opaque ... },
  "valid_until": "2026-07-06",
  "feature_graph_hash": "blake3:...",
  "extractor_version": "aberp-cad-extract@0.4.1",
  "engine_version": "aberp-quote-engine@0.7.0",
  "stock_alert": false }
--boundary
Content-Disposition: form-data; name="pdf"; filename="quote.pdf"
Content-Type: application/pdf

<binary>
--boundary--
```

Returns `200 { "status": "quoted" }` on success, `409 { "error": "already_priced", "feature_graph_hash": "..." }` if the same hash has already been written (idempotent re-write returns 200 with no mutation; a different hash on an already-priced quote forces ABERP to mint a new quote_id per design §10).

**`POST /q/{id}/accept`** (form-submit from the accept-confirm page)

The accept page is itself loaded via `GET /q/{id}/accept?ts=<expiry>&sig=<sig>`; the POST re-checks the same HMAC. Body is a normal form-POST with a CSRF-style nonce. Returns `303` redirect to `/q/{id}?t=<status-token>` showing the new `approved` state.

---

## 7. HMAC link signing — extension to today's scheme

### Today (PR-L)

`src/lib/server/quote-token.ts` signs `HMAC(id, secret)` and returns base64url. **No expiry encoded.** A token never expires until `QUOTE_STATUS_SIGNING_KEY` is rotated.

This was fine for the _status-page_ link (PR-L's only consumer): the worst case of an old token leaking is a stranger sees the _status_ of a stale quote. It is **not** fine for the _accept_ link, which is a commercial commitment.

### New (ADR-0005)

Two distinct token shapes, both base64url:

| Token            | Material signed                                                                         | Used for                                                 | Expiry                                                                         |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **status token** | `HMAC(id ‖ "status", secret)`                                                           | `/q/{id}?t=<token>` and `/api/quotes/{id}/pdf?t=<token>` | NONE (today's behavior preserved — kill switch is key rotation)                |
| **accept token** | `HMAC(id ‖ "accept" ‖ expiry_iso, secret)`, presented as `?ts=<expiry_iso>&sig=<token>` | `/q/{id}/accept?ts=&sig=` (GET + POST)                   | 30-day from issue (the design-doc commitment §12 / ABERP-side §12, pushback M) |

**Why distinct domains in the HMAC input.** Domain separation (the literal `"status"` / `"accept"` string mixed into the HMAC) prevents a status-link signature from being replayed as an accept-link signature even if an attacker captures one of each. Standard pattern, no exotic crypto.

**Why expiry in the URL not the body.** A token whose expiry is also signed binds the validity window to the signature — the attacker can't extend the expiry by editing the URL. Server-side check: parse `ts`, recompute HMAC over `(id, "accept", ts)`, constant-time compare; THEN check `ts` is in the future. Doing the HMAC before the expiry check is intentional — a wrong signature should return 403 regardless of whether the expiry is in the past, so a probe can't distinguish "valid signature but expired" from "invalid signature."

**Secret storage.** `QUOTE_STATUS_SIGNING_KEY` env var (today's name preserved — re-used for both token types). Per `/etc/aberp-site.env`, chmod 600, chown aberp:aberp. Lives on the Lightsail box; not in any AWS-managed secret store. Rotation = stop the systemd unit, edit the env, restart — invalidates every issued link at once (the kill switch).

**No customer portal in v1.** The link IS the surface, per `[[hulye-biztos]]` (one click, no decisions). A portal would need accounts + passwords + reset flows — multi-PR sink for one-time customers. When `[[aberp-saas-migration]]` lands, upgrade to portal.

---

## 8. Material catalogue receiver — what the S266 push lands on

### The ABERP-side push (already shipped)

[`crates/aberp-quote-engine`... wait, no — `apps/aberp/src/catalogue_push.rs`](../../../ABERP/apps/aberp/src/catalogue_push.rs) emits a `PUT /api/catalogue/materials` every 15 minutes (`PUSH_CADENCE_SECS = 900`) **plus** an immediate trigger on each operator CRUD write. Bearer is `ABERP_QUOTE_INTAKE_TOKEN` on the ABERP side, which **is** the storefront's `ABERP_SITE_ADMIN_TOKEN` (one secret, one surface, per `[[aberp-smtp-spoc]]`).

On a 401 the daemon **pauses** (sticky until next `aberp serve` boot) and audits `quote.material_catalogue_pushed { outcome: "unauthorized" }`. Other non-2xx errors back off exponentially (5s → 15s → 60s → cadence). The PUT body is a **full snapshot** — the storefront MUST treat each PUT as the complete active catalogue (a grade absent from the body has been deleted).

### The storefront receiver — what PR-02 builds

A single endpoint `PUT /api/catalogue/materials` (ADR-0003) that:

1. Validates the bearer via the existing `requireAdminAuth(request)` helper. **No new secret.** The `ABERP_SITE_ADMIN_TOKEN` already protects `/api/quotes*` and `/admin/*`; reuse it.
2. Parses the body, validates each material row:
   - `grade` — required, ASCII, max 64 chars, matches `/^[A-Z][A-Z0-9_]*$/`.
   - `display_name` — required, max 200 chars, header-injection-safe (the same `HEADER_INJECTION_RE` pattern `/api/quote/+server.ts` uses).
   - `stock_status` — required, in the closed enum `{in_stock, source_1_2d, source_3_7d, source_2_4w, special_order}`.
   - `lead_time_default_days` — required, non-negative integer ≤ 365.
3. Writes the entire body atomically to `/data/catalogue/materials.json` (tmpfile + rename pattern — same `writeQuoteAtomic` posture as `quote-store.ts`).
4. Returns `200 { "received_count": N }`.

Reject `4xx` cleanly: 400 on schema error (one bad row rejects the entire snapshot — by design, since ABERP treats the PUT as atomic; partial replace would diverge ABERP's snapshot from the storefront's cache), 401 on bad bearer, 413 if body > 1 MB (sanity cap).

### The public reader — what `/quote` consumes

A second endpoint `GET /api/catalogue/materials` (public, no auth) that returns the cached snapshot:

```json
{
	"materials": [
		{
			"grade": "AL_6061_T6",
			"display_name": "Aluminium 6061-T6",
			"stock_status": "in_stock",
			"lead_time_default_days": 0
		}
	],
	"received_at": "2026-06-06T18:00:00Z"
}
```

The `/quote` page's material dropdown (`src/routes/quote/+page.svelte:279`) replaces its hard-coded `<option>` list with a fetch of `/api/catalogue/materials` at hydration time. Fallback when the catalogue is empty (first boot, ABERP never connected yet): show the existing six-option hard-coded list (today's behavior preserved, with a small "list may be limited until our shop sync runs" note). Per `[[trust-code-not-operator]]`, never leave the form unusable because the catalogue cache is cold.

**The form submits `grade` not `material_preference`** going forward. The existing closed enum `ALLOWED_MATERIALS` in `/api/quote/+server.ts` widens to "accept either a legacy preference (aluminum/steel/...) OR a grade from the current catalogue snapshot." Backwards-compat for any in-flight pre-S276 customer who left a tab open.

---

## 9. Customer email — pushback against the brief

### The brief said

> "SMTP via existing ABERP SPOC ([[aberp-smtp-spoc]]). Storefront cannot have its own SMTP creds; uses ABERP's via an internal email-send endpoint."

### The correction

Per `[[pushback-as-method]]`, the brief is wrong on the _mechanism_ and right on the _credential constraint_.

**Right:** "SMTP creds are SPOC" — there is one set of SMTP creds across all surfaces. Storefront uses the same `user`/`pass`/`from` as ABERP's invoice-mail path.

**Wrong:** "Storefront cannot have its own SMTP creds; uses ABERP's via an internal email-send endpoint."

The storefront **already has the SMTP creds locally** (PR-K, `/etc/aberp-site.env`'s `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`) and sends mail directly via `src/lib/server/email.ts:222` (`sendQuoteNotifications`). That code is on prod today. The SPOC rule is about **which mailbox the credentials authenticate as** (one), not about **which process holds them** (any number, as long as the credential value is identical).

Building an internal email-send endpoint on ABERP would mean:

- The storefront POSTs to ABERP (we already established ABERP has **no public inbound surface** — `[[aberp-site-ssr-live]]` notes the architecture, ADR-0057 / ABERP-side §1 makes it a topology law).
- The cleanest workaround is a _reverse_ polling loop where the storefront stages pending-emails and ABERP polls them and sends. That is **three round-trips** to send one mail. Inferior to today's direct send.
- The new endpoint surface is itself a new attack vector and a new auth contract.

**The corrected mechanism for v1:** the storefront sends customer email directly via the local SMTP relay. `src/lib/server/email.ts` already does this. The new "your quote is priced" customer email is a new message in that same file (per ADR-0006), authored on the priced-writeback POST path. The "ABERP relay endpoint" idea is **rejected**, and `[[aberp-smtp-spoc]]` is preserved by keeping the credential values identical across surfaces (operator discipline — but it's already true today, the env var was populated from ABERP's keychain on Lightsail bootstrap).

If/when SaaS migration (`[[aberp-saas-migration]]`) puts ABERP behind a public surface and a future audit requires "one process sends all mail," that's the moment to revisit. **Pin in ADR-0006.**

### What the storefront sends

Two new customer-facing messages, both authored in `src/lib/server/email.ts`:

1. **"Your quote is ready"** — sent on `POST /api/quotes/{id}/priced` success. Subject: `Ajánlat <id-short> — készen áll / Your quote is ready`. Body: 1-2 paragraphs HU+EN, prominent CTA `Accept this quote` linking to `/q/{id}/accept?ts=<expiry>&sig=<sig>`, the PDF attached as `quote.pdf`.
2. **"Quote expiring soon"** (out of scope v1, flagged for ADR-0005 follow-up) — sent at `valid_until − 3 days` if still `quoted`. Lives in the daemon-sweep that flips `quoted → rejected` on expiry.

Plus the existing PR-K message ("we received your CAD") and the operator notification — unchanged.

---

## 10. Implementation slice plan — 4 PRs

Each slice is ~1 PR per `[[overnight-batch-style]]`, ground-up against this doc.

### PR-02 (Session ~277): Material catalogue receiver

**What lands**

- `PUT /api/catalogue/materials` endpoint (ADR-0003).
- `GET /api/catalogue/materials` public reader.
- Cache file at `/data/catalogue/materials.json`, atomic write.
- `/quote` page: dropdown fetches from cache, falls back to hardcoded list when empty.
- Tests: PUT validation (one bad row rejects all), GET-when-empty fallback, PUT-then-GET round-trip.

**Builds on:** existing `requireAdminAuth`, `writeQuoteAtomic` pattern, dropdown markup.

**EVE addenda touched:** none directly. Sets up the data the addendum-2 banner reads.

### PR-03 (Session ~278): Priced-quote writeback contract + state machine

**What lands**

- `POST /api/quotes/{id}/priced` endpoint (ADR-0004) — multipart body, validates JSON meta, persists PDF, extends metadata.json.
- `QUOTE_STATUSES` extended: `quoting`, `quoted` states reachable via Bearer writeback.
- `POST /api/quotes/{id}/status` accepts `quoting` (idempotent on second pull) and `quoted` (only via priced writeback).
- `GET /api/quotes/{id}/pdf?t=<token>` for customer PDF download (HMAC-gated).
- `/q/{id}` status page renders the priced PDF inline, shows the `stock_alert` banner from the priced-writeback payload (addendum 2 customer-side).
- Tests: priced-writeback golden, idempotent re-write same hash, conflict-on-different-hash, status-machine invariants, PDF-download HMAC.

**Builds on:** `quote-store.ts`, existing status writeback, HMAC helpers.

**EVE addenda touched:** **addendum 2 customer side** lands here — the `stock_alert` flag from the wire body drives the customer-facing banner on `/q/{id}?t=<...>`. Cut report MUST call this out by name.

### PR-04 (Session ~279): HMAC accept link with expiry + accept-confirm UI

**What lands**

- Extend `quote-token.ts`: new `signAcceptToken(id, expiryIso)` / `verifyAcceptToken(id, expiryIso, token)` with domain-separation per ADR-0005. Existing `signQuoteToken` / `verifyQuoteToken` get a `"status"` domain marker for forward-compat; **the wire-format of the existing status token is preserved** (so today's PR-L links keep working — the new domain marker is added under a feature flag that turns on with PR-04 deploy).
- New routes: `GET /q/{id}/accept?ts=&sig=` (the customer-facing confirm landing), `POST /q/{id}/accept` (the single-use commit).
- Customer accept-confirm page UI — **big, loud, single-use, with a typed confirmation pattern** (addendum 3 customer analog: same energy as ABERP DEAL token + storno confirm). Customer types `ACCEPT` (or clicks a deliberately oversized confirm button — pick one in design, brief should choose the typed variant for `[[hulye-biztos]]` parity).
- 409 on replayed accept.
- Customer email send on priced-writeback (the "your quote is ready" message, with attached PDF).
- `quoted → rejected` daemon sweep on `valid_until` lapse (lightweight: a cron-style sweep on next-poll-fired, since the storefront doesn't run its own scheduler today — or a setInterval in the Node process on boot).
- Tests: token sign/verify with expiry, expiry-past returns 403, single-use, accept flips state, replay returns 409, expiry-sweep flips `quoted → rejected`.

**Builds on:** `quote-token.ts`, `email.ts`.

**EVE addenda touched:** **addendum 3 customer analog** — the accept page is the customer's DEAL moment. Cut report MUST call this out by name.

### PR-05 (Session ~280): Polish + walkthrough + end-to-end smoke

**What lands**

- Walkthrough doc `docs/walkthroughs/auto-quote-end-to-end.md` per `[[walkthrough-format]]` — WHERE-tagged step-by-step Ervin runs once to confirm prod E2E.
- Operator admin `/admin/quotes/{id}` shows the priced breakdown (read-only), accept-state, `stock_alert` flag.
- Settings → "Catalogue sync status" surface (read-only display of `received_at` from `/data/catalogue/materials.json`, gives the operator a "last ABERP sync" sanity).
- Adversarial review of PR-02..PR-04 (the cut report mode per `[[overnight-batch-style]]`).
- `+error.svelte` for the new accept routes if PR-04 didn't cover.

**Builds on:** all prior.

**EVE addenda touched:** walkthrough validates addenda 2 + 3 end-to-end. Stock-alert customer banner shows in the walkthrough's "expected screenshot" sections.

---

## 11. Walkthrough plan — operator-facing end-to-end test

This walkthrough lives in `docs/walkthroughs/auto-quote-end-to-end.md` and lands in PR-05. Per `[[walkthrough-format]]`, every step is numbered and WHERE-tagged, AWS Console preferred over CLI, exact one-liners, verify line after each.

The walkthrough below is the **plan** — the full walkthrough body is PR-05's deliverable. Sketched here so PR-05's brief can fill it in cleanly.

### Pre-conditions (already true after PR-02..PR-04 ship)

- ABERP-site is live on Lightsail at `abenerp.com` (`[[aberp-site-ssr-live]]` validated).
- ABERP desktop is running `PROD_v2.26.1` or later (the auto-quoting closed batch).
- `ABERP_SITE_ADMIN_TOKEN` matches ABERP's `quote_intake_token` (the SPOC bearer).
- `ABERP_QUOTE_INTAKE_URL=https://abenerp.com` configured on ABERP.
- Material catalogue is populated in ABERP (S266 ships seed rows).

### Walkthrough steps

1. **[Local terminal]** Verify ABERP is up and the daemon is healthy.

   ```sh
   curl -fsS http://127.0.0.1:8787/api/health
   # expect: {"status":"ok",...}
   ```

   Open ABERP Settings → Quote Intake — should show "running, last cycle <recent>."

2. **[Browser, abenerp.com/quote]** Submit a quote as if you were a customer.
   - Name: `Walkthrough Test`
   - Email: a real address you can read (use the `+` trick: `you+walkthrough@yourdomain`).
   - Material: pick from the dropdown (should reflect ABERP's current catalogue per PR-02).
   - Quantity: 5.
   - CAD: a small known-good `.step` (`docs/walkthroughs/fixtures/cube.step` will be committed in PR-05).
   - Submit. Note the quote ID on the confirmation page.

3. **[Browser email]** Confirm the immediate "we received your CAD" email arrived. Click the status link → should show state `received` (HU: "Beérkezett").

4. **[ABERP Quotes tab]** Wait ≤ 90s for the next ABERP poll cycle. The new quote should appear in ABERP's Quotes tab with state `received-on-storefront` (no priced row yet — ABERP is still extracting).
   - Verify the status link in the customer's browser flips to `quoting` (HU: "Árazás folyamatban").

5. **[Browser, status link]** Wait another ≤ 30-60s for extraction + pricing. The customer status link should flip to `quoted` and now show the indicative PDF inline.

6. **[Browser email]** Confirm the "your quote is ready" email arrived with the PDF attached and a prominent **Accept this quote** button.

7. **[ABERP SPA, Quotes tab]** Confirm the quote shows state `indicative` with the full breakdown rendered.
   - **Verify the `stock_alert` flag**: if the material picked has stock_status ≠ `in_stock`, ABERP should show the addendum-2 sticky banner. The customer-side status page should ALSO show its own banner copy ("Stock status changed since this quote was issued").

8. **[Browser email]** Click **Accept this quote**.
   - Land on the accept-confirm page. **Verify the addendum-3 customer UX** — big confirm, single-use intent visible.
   - Type `ACCEPT` (per `[[hulye-biztos]]`) and submit.
   - Land on the status page showing `approved` (HU: "Elfogadva").

9. **[Browser email]** Try clicking the accept link again from the email. Should land on a 409-styled "this quote is already accepted, our team is preparing your order" page.

10. **[ABERP Quotes tab]** Next poll cycle ≤ 60s — the quote moves to `accepted` on ABERP. The operator types the DEAL token (`PROD_v2.26.1` already shipped this UX with the big/red/single-use addendum 3). DEAL fires; saga runs; storefront's next poll cycle sees writeback `status=invoiced`.

11. **[Browser, status link]** Final state: `invoiced` (HU: "Számlázva"). Walkthrough complete.

### When things go wrong (troubleshooting block)

- **Quote stays in `received` past 2 min** — ABERP daemon paused or storefront-credential drift. Check ABERP Settings → Quote Intake "paused" banner; re-paste bearer if 401.
- **Quote reaches `quoting` but never `quoted`** — ABERP extractor crashed on the CAD or the priced-writeback POST is failing. Check ABERP `tracing` log for `aberp-cad-extract-wrapper` errors and `catalogue_push` / writeback Transport errors.
- **Accept link 403s** — wrong sig or expiry past. The token expires 30 days after issue; re-issue from ABERP-side "Re-quote" affordance (post-PR-05 enhancement).
- **PDF download 404s** — `priced.pdf` was never written or was deleted. Check `/data/quotes/{id}/priced.pdf` exists on the box.
- **Stock-alert banner shows on a stable-stock quote** — sticky flag on ABERP side (addendum 2 makes it sticky); operator must REFRESH on ABERP to clear.

---

## 12. EVE addenda enforcement — where each lands on this side

Per `[[aberp-quoting-design-addenda]]`, the three addenda were promoted from backlog to MANDATORY mid-S266. Each PR cut report MUST call them out by name with pass/fail. ABERP-side addendum 1 + 2 + 3 all landed by `PROD_v2.26.1`. The **storefront-side echoes** of addendum 2 and 3 land in this batch.

### Addendum 1 — FeatureGraph `requires_5_axis` + `thin_wall_present`

**Where it lives:** purely ABERP-side (`aberp-cad-extract` JSON schema). Storefront never sees these flags.

**Storefront-side enforcement:** none. Storefront's `breakdown_json` field is opaque per design §4 — we do not inspect FeatureGraph contents.

### Addendum 2 — `stock_alert` HARD-blocks DEAL until REFRESH

**ABERP-side enforcement (already shipped, PROD_v2.26.1):** sticky flag, REFRESH token gates DEAL.

**Storefront-side enforcement (this batch):**

- Priced-writeback wire body carries `stock_alert: bool` (§4 schema, §6 wire shape).
- The customer-facing status page `/q/{id}?t=<...>` renders a hard banner when `stock_alert == true` on the persisted `pricing` record: "Stock status changed since this quote was issued — pricing may be refreshed if not accepted by <valid_until>."
- The accept link is NOT customer-side blocked. The operator-side REFRESH gate is what enforces; the customer banner is informational. Per `[[trust-code-not-operator]]`, the storefront never asks the customer to acknowledge an operator-side state.
- **PR-03 cut report MUST explicitly state:** "Addendum 2 customer-side banner: PASS — `stock_alert: true` on priced-writeback renders the banner on `/q/{id}?t=<...>`; verified by integration test `priced-writeback-stock-alert.spec.ts`."

### Addendum 3 — DEAL token field big/red/single-use

**ABERP-side enforcement (already shipped):** the operator DEAL token UI is big/red/single-use, per `[[hulye-biztos]]` and S156's storno pattern.

**Storefront-side enforcement (this batch):** the **customer-side equivalent is the accept link landing page**. The customer is making _their_ commitment moment, mirroring the operator's DEAL.

- Accept-confirm page: large prominent CTA, single confirmation token (customer types `ACCEPT`), single-use enforcement (replayed accept returns 409).
- **PR-04 cut report MUST explicitly state:** "Addendum 3 customer-side accept UX: PASS — accept-confirm page renders large CTA, single-use enforced via state-machine invariant (409 on replay), customer types `ACCEPT` token; verified by Playwright test `accept-confirm.e2e.ts`."

---

## 13. Open questions

Items where a real call is needed but not blocking for the design pin. Each one has the conservative default chosen per `[[no-ask-user-question]]`; Ervin can flip with a sentence.

1. **Accept-confirm UI: typed token or oversized button?**
   - Conservative pick: **typed token `ACCEPT`** (`[[hulye-biztos]]` parity with operator DEAL UX, customer makes a deliberate commitment).
   - Alternative: oversized button with a 3-second hold (less deliberate, lower friction, web-app convention).
   - **Decision needed before PR-04.**

2. **PDF attachment in the "your quote is ready" email — attach or link-only?**
   - Conservative pick: **attach** the PDF (customer can read it offline, doesn't depend on the link staying live). 50 MB cap is comfortable; PDFs are ~100KB.
   - Alternative: link-only (server controls revocation, smaller mail).
   - **Decision needed before PR-04.**

3. **`valid_until` enforcement: sweep cadence?**
   - Conservative pick: **sweep on every customer-facing GET `/q/{id}?t=<...>` hit** (lazy enforcement, no scheduler needed). Daemon sweep is a follow-up.
   - Alternative: daily cron via systemd timer (proper, more infrastructure).
   - **Decision needed before PR-04 (or defer enforcement to PR-05).**

4. **What is the storefront's versioning scheme?**
   - The brief asks "figure out the storefront repo's tag convention (likely separate from ABERP's `PROD_v*` scheme; might be its own versioning) and document but don't tag this session."
   - **Today's reality:** the ABERP-site repo has **no tags at all**. Every PR lands on `main` via merge commit (PR-A through PR-T sequence visible in `git log`). The "version" of a deployed ABERP-site is the SHA of `main` at deploy time.
   - **Conservative pick:** keep PR-letter naming for code sessions (PR-02, PR-03, PR-04, PR-05 this batch — distinct from the ABERP-site historical PR-A..PR-T which is a _letter_ sequence; this batch is _numbered_ to mark the auto-quote arc). **No version tags introduced** until a deploy operator (Ervin) needs to reference "the version live at customer X's complaint timestamp" — at which point cut `ABERP_SITE_v0.1.0` per a future versioning ADR.
   - **Pin in this doc, no ADR — versioning ADR is a follow-up if/when needed.**

5. **What happens to in-flight `received` quotes from before PR-02 lands?**
   - Conservative pick: **forward-compat** — the existing wire body has no `pricing` field; ABERP's forward-tolerant parser (`payload.rs`'s `#[serde(flatten)]` tail) accepts new fields fine; the priced-writeback is purely additive. Old quotes either age out via operator action or get retroactively priced if ABERP re-polls.
   - No migration step needed.

6. **CAD content-sniff (`[[aberp-site-cad-validation]]`, PR-P) — interaction with priced-writeback?**
   - The existing content-sniff at intake catches "taxi receipt with `.step` extension." Good. **No interaction with this batch.** ABERP's extractor will fail loud on invalid geometry (the wrapper crate `aberp-cad-extract-wrapper` sandboxes + types the failure); the priced-writeback then needs an "error" outcome.
   - **Open follow-up:** define a `POST /api/quotes/{id}/extract-failed` writeback for the case "ABERP couldn't extract from this CAD." Out of scope this batch — defer to PR-06 if needed.

7. **Catalogue receiver — what if ABERP pushes an empty catalogue?**
   - Conservative pick: **empty payload is legal** (= "all materials deleted" per the snapshot-replace contract). Storefront caches it. The dropdown then has only the unknown-fallback option. The operator's responsibility to populate (ABERP-side catalogue CRUD enforces ≥ 1 grade typed before a push fires).
   - **No action needed.**

---

## Appendix A — Wire-contract glossary

| Term                    | Definition                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storefront**          | abenerp.com — this repo, the SvelteKit app on Lightsail eu-central-1                                                                                    |
| **ABERP**               | The Tauri desktop ERP on Ervin's Mac — pulls quotes, runs the engine, drives DEAL                                                                       |
| **Bearer (storefront)** | `ABERP_SITE_ADMIN_TOKEN` — the bearer the storefront accepts on `/api/quotes*` and `/api/catalogue/*`                                                   |
| **Bearer (ABERP)**      | `ABERP_QUOTE_INTAKE_TOKEN` (env) / `quote_intake_token` (keychain) — must equal the storefront's `ABERP_SITE_ADMIN_TOKEN` (SPOC)                        |
| **Status token**        | HMAC-signed token, signs `(id, "status")`, no expiry — for read-only customer status access                                                             |
| **Accept token**        | HMAC-signed token, signs `(id, "accept", expiry_iso)`, 30-day expiry — for one-time customer commitment                                                 |
| **`stock_alert`**       | Sticky boolean flag set on the priced quote when material stock status downgraded between issue and now. Addendum 2 mandates a customer-visible banner. |
| **Indicative quote**    | The ABERP-internal term for `quoted` on the storefront — same artifact, two names                                                                       |
| **DEAL**                | The operator's commercial-commitment trigger on ABERP. Customer-side analog is the accept-confirm page.                                                 |

---

## Appendix B — Connection to other memory and ADRs

- `[[aberp-auto-quoting]]` — parent project memory (15 pushbacks, sequencing); this doc is the storefront-side mirror of the ABERP-side ground-zero design.
- `[[aberp-quoting-design-addenda]]` — three mandatory addenda; addenda 2 + 3 enforced on this side.
- `[[aberp-site-ssr-live]]` — the runtime substrate this design assumes (Lightsail, CloudFront, `/etc/aberp-site.env`).
- `[[aberp-site-cad-validation]]` — PR-P shipped content-sniff at intake; this design assumes it; open follow-up Q#6.
- `[[aberp-smtp-spoc]]` — credential-SPOC rule; pushback in §9 + ADR-0006 clarifies it is about credentials not architecture.
- `[[trust-code-not-operator]]` — invariants in code; the state machine §5 enforces in TS, not in FS.
- `[[hulye-biztos]]` — accept-confirm UX is the customer DEAL moment.
- `[[no-sql-specific]]` — no DB; filesystem JSON.
- `[[walkthrough-format]]` — §11 plan, full walkthrough lands in PR-05.
- `[[pushback-as-method]]` — §9 push back on the brief's SMTP-relay premise; §2 push back on Options A and C.
- ABERP-side ADRs referenced: ADR-0057 (quote-intake architecture), ADR-0066 (quote-engine architecture), ADR-0067 (DEAL saga), ADR-0069 (material reservations), ADR-0064 (dispatch), ADR-0062 (work orders), ADR-0007 (keychain), ADR-0014 (CAD artifact handling).
