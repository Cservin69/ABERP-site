# S337 / PR-22 — Material-grade vocabulary verification (verdict: **SHIPPED**)

**Date:** 2026-06-10
**Scope:** Confirm the storefront `/quote` material dropdown offers only values the
ABERP quote-engine catalogue can actually price (1:1 vocab match).
**Outcome:** No storefront code change. The dispatch assumed the dropdown was a
hard-coded generic list (`MISSING`); verify-first found the catalogue-fed dropdown
**already shipped** in S276/PR-01–PR-02 per [ADR-0003](../adr/0003-material-catalogue-receiver.md).
One **real, out-of-repo** defect was uncovered (ABERP grade format) — see §3.

---

## 1. What the dispatch assumed vs. what is true

The brief quoted the storefront as offering a static list — _Not sure / Aluminum /
Steel / Stainless / Brass / Plastic / Other_ — with no catalogue grades, and asked
for a full rebuild.

That list is **only the cold-cache fallback**
([`src/routes/quote/+page.svelte:313-319`](../../src/routes/quote/+page.svelte)).
The live dropdown is dynamically fed from the pushed ABERP catalogue. The dispatch
read the `{:else}` branch as if it were the whole `<select>`.

## 2. The shipped architecture (Option A, push-form — single source of truth in ABERP)

The brief's recommended "Option A: storefront pulls the catalogue from ABERP" is
already built, inverted to a **push** because ABERP has no public inbound surface
(ADR-0002 / ABERP ADR-0057). End-to-end, verified file:line:

| Stage                              | Location                                                                                                           | Evidence                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| ABERP emits live catalogue         | `ABERP/apps/aberp/src/catalogue_push.rs`                                                                           | `PUT {storefront}/api/catalogue/materials` every 15 min + on every operator CRUD write; Bearer = SPOC quote-intake token |
| Wire projection (no pricing IP)    | `ABERP/apps/aberp/src/quoting_materials.rs:179` (`PublicMaterial`), `:460` (`list_public`)                         | `{ grade, display_name, stock_status, lead_time_default_days }`                                                          |
| Storefront receiver (Bearer)       | [`src/routes/api/catalogue/materials/+server.ts:13`](../../src/routes/api/catalogue/materials/+server.ts)          | validates → atomic write to `/data/catalogue/materials.json`                                                             |
| Validation / closed-vocab guard    | [`src/lib/server/catalogue-store.ts:34`](../../src/lib/server/catalogue-store.ts)                                  | `GRADE_RE = /^[A-Z][A-Z0-9_]*$/`, stock-status enum, header-injection guard; one bad row 400s the whole snapshot         |
| Public reader                      | [`src/routes/api/catalogue/materials/+server.ts:55`](../../src/routes/api/catalogue/materials/+server.ts)          | `GET` (no auth), `Cache-Control: public, max-age=60`                                                                     |
| `/quote` dropdown consumes it      | [`src/routes/quote/+page.svelte:28-41`](../../src/routes/quote/+page.svelte) (fetch on mount), `:307-321` (render) | renders `<option value={grade}>{display_name}</option>` per catalogue row; generic list is fallback only                 |
| `/api/quote` constrains `material` | [`src/routes/api/quote/+server.ts:133-136`](../../src/routes/api/quote/+server.ts)                                 | accepts a legacy preference **OR** a grade in the current snapshot; else `400 Invalid material selection`                |

### Manual-review escape valves (correctly routed, per the brief's requirement)

- `unknown` ("Not sure / ask us") and `other` ("Other — note below") are in
  `LEGACY_MATERIAL_PREFERENCES` ([`+server.ts:36-44`](../../src/routes/api/quote/+server.ts)).
  They are accepted, persisted as `request.material_preference`, and surface in
  `/admin/quotes` — they do **not** carry a catalogue grade into the auto-pricer.
  This is the manual-review queue, not a dead-letter.
- The cold-cache generic labels (`aluminum`, `steel`, …) are also legacy
  preferences → same manual-review destination. Picking "Aluminum" while the cache
  is cold is functionally identical to picking "Not sure": the quote is persisted,
  the customer gets a reference ID + receipt email, the operator can price it by hand.

## 3. Real defect found — **ABERP-side grade format violates the wire contract** ⚠️

The storefront contract (ADR-0003, and both test suites:
`catalogue-store.spec.ts`, `catalogue.spec.ts`) requires `grade` to match
`/^[A-Z][A-Z0-9_]*$/` — the normalized form `AL_6061_T6`, `TI_6AL_4V`, `SS_316L`.
ADR-0003's wire example shows exactly that.

But the **actual ABERP emitter pushes the raw `quoting_materials.grade` natural
key, unnormalized**:

- `ABERP/apps/aberp/src/quoting_materials.rs:40` — _"the canonical key (e.g.
  `6061-T6`); it is also what the storefront dropdown keys on."_
- Seed + unit tests assert `grade == "6061-T6"`, `"304"`, `"Ti-6Al-4V"`,
  `"Inconel 718"` (`:315`, `:892`).
- `list_public` (`:465`) selects `grade` verbatim — **no normalization**;
  `validate_material_inputs` only checks non-empty — **no format guard**.

`6061-T6` / `304` / `Ti-6Al-4V` all **fail** `GRADE_RE` (leading digit, hyphen,
space, lowercase). The storefront's `validateSnapshotBody` rejects the _entire_
snapshot on the first bad row → the catalogue cache **never populates** → the
dropdown is **permanently stuck on the generic fallback** in production.

So the shipped storefront feature is silently inert end-to-end until ABERP is fixed.

**Fix belongs in ABERP, not here.** Do **not** loosen the storefront `GRADE_RE`:
the normalized form is the documented contract, the regex is a deliberate
canonicalization + injection-safety guard, and the storefront tests assert the
non-normalized forms are rejected. ABERP must normalize `quoting_materials.grade`
to `/^[A-Z][A-Z0-9_]*$/` (a `family`-prefixed slug, e.g. `AL_6061_T6`) at write or
at push time. Tracked as a follow-up in the ABERP repo.

## 4. Incidental observation — gating test flake (not this PR's subject)

`src/routes/api/quote/submission-email.spec.ts` ("happy path … one queue entry")
flakes ~50% in the full parallel suite (passes in isolation). Root cause:
`src/lib/server/email-outbox.ts:56` captures `OUTBOX_DIR` from `process.env` once
at module load; under vitest's shared-worker parallelism the first importing spec
freezes the dir, so this spec intermittently writes to a sibling spec's tmpdir.
Distinct from the now-fixed S333 exit-hang. Surgical fix = read the dir at call
time. Belongs to the S313–S333 test-stability track ("awaiting Ervin's direction"),
not a material-vocab PR. Tracked as a follow-up.

## 5. Verdict

**SHIPPED** — the `/quote` dropdown already offers exactly the catalogue grades
ABERP supports (when the cache is warm) and routes everything else to manual
review. No storefront change is warranted. The blocker to this feature being live
is the §3 ABERP grade-format mismatch, fixed in the ABERP repo.
