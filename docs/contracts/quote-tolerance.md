# Wire contract — customer tolerance on the storefront quote (`/api/quote`)

- **Status:** Active (storefront side shipped here). Consumer side (Defense quote-intake → engine `ToleranceSpec`) is implemented in a following session.
- **Date:** 2026-06-29
- **Grounds:** ADR-0097 (ABERP-Editions) — quote-engine machining-tolerance cost driver, **Q6** (customer storefront granularity) and **Part 1** (`ToleranceSpec` taxonomy). This repo is `Cservin69/ABERP-site` (the live storefront, `abenerp.com`); the engine + intake live in `Cservin69/ABERP-Editions`.
- **Scope guard:** Storefront (this repo) only. No engine/intake code is changed here. Frozen prod (`Cservin69/ABERP`) is never touched.

## Why

ADR-0097 records that the storefront `/quote` form did not collect tolerance at all, so the pricing daemon fell back to a hardcoded `Standard` band. This contract closes that gap from the customer side: the storefront now collects a **foolproof, closed-vocabulary** tolerance selection and hands it to ABERP's quote-intake, which (next session) maps it onto the engine's `ToleranceSpec`.

Customers do not buy IT grades or ± values — over-asking garbles input and loses quotes (ADR-0097 Q6, "Alternatives considered"). The customer surface is therefore a small guided dropdown plus an optional, descriptive-only note that routes to **operator review**. The operator owns precision downstream.

## The payload (storefront → `/api/quote`, `multipart/form-data`)

| Field                | Type   | Required | Allowed / shape                           | Notes                                                                                     |
| -------------------- | ------ | -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tolerance`          | string | no       | `general` \| `precision` \| `per_drawing` | Absent or empty ⇒ defaults to `general`. Any other value ⇒ **rejected** (see Validation). |
| `tolerance_critical` | string | no       | `"true"` when checked; otherwise omitted  | The customer flagged that some features need tighter tolerance.                           |
| `tolerance_note`     | string | no       | free text, **≤ 500 chars**, no CR/LF/NUL  | **Descriptive only — never parsed into pricing.** Routed to operator review.              |

### Closed vocabulary (display order; `general` is the default)

| Token         | Customer-facing label               | Meaning                                                                   |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `general`     | General machining (ISO 2768-m)      | Title-block default; suits most parts. **Default.**                       |
| `precision`   | Precision (ISO 2768-f)              | Fine general tolerance class.                                             |
| `per_drawing` | High precision — specify on drawing | GD&T / tight fits called out on the drawing → **operator manual review**. |

The vocabulary is the single source of truth in `src/lib/tolerance.ts` (`TOLERANCE_SCHEMES`); the server validator (`src/lib/server/tolerance-validate.ts`) and the form/admin UI all import it.

## Validation (server-side, foolproof)

`POST /api/quote` validates `tolerance` against the closed vocabulary, mirroring the `cad-validate.ts` content-sniff posture:

- **Out-of-vocabulary** (e.g. `IT7`, `+/-0.01`, `ultra`, `GENERAL`) ⇒ **HTTP 400** with a structured body that mirrors the `invalid_file` shape:

  ```json
  {
  	"error": "invalid_tolerance",
  	"reason": "Tolerance must be one of general, precision, per_drawing but received `IT7`."
  }
  ```

- **Absent or empty** ⇒ treated as `general` (inert / back-compat with pre-tolerance submissions).
- `tolerance_note` longer than 500 chars ⇒ `400 { "error": "Tolerance note too long." }`; CR/LF/NUL in the note ⇒ `400 { "error": "tolerance note contains invalid characters." }` (shared header-injection guard).

Because the customer UI is a closed `<select>`, a real customer can never produce an out-of-vocab value; the 400 path exists purely as the hand-crafted/replayed-POST backstop ("hülye-biztos" for customers too).

## Persistence (storefront state — `metadata.json`)

The values land under `request` in the quote's `metadata.json` (`QuoteMetadata.request`):

```json
{
	"request": {
		"material_preference": "AL_6061_T6",
		"quantity": 10,
		"deadline": null,
		"notes": "",
		"tolerance": "per_drawing",
		"tolerance_critical": true,
		"tolerance_note": "bore Ø12 H7; flatness on the top face"
	}
}
```

All three fields are **optional** in the type: quotes written before this shipped have them absent, and every reader treats absent `tolerance` as `general`. The operator sees them on `/admin/quotes/{id}`; the operator notification email carries a `Tolerance:` line and a `Tolerance review: MANUAL REVIEW` line when review is warranted.

## Recommended mapping to the engine `ToleranceSpec` (consumer side — next session)

The Defense quote-intake should map the storefront token onto ADR-0097 Part 1's `ToleranceSpec` as follows. This is the **recommended** mapping for the intake to implement; it is **not** implemented in this repo.

| Storefront `tolerance` | Engine `ToleranceSpec`                  | Normalised internal band (ADR-0097 `tightness()`)                                       |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `general` (default)    | `GeneralClass { class: Iso2768Medium }` | `Standard` — **byte-identical to today's default** (ADR-0097 Q1)                        |
| `precision`            | `GeneralClass { class: Iso2768Fine }`   | `Tight`                                                                                 |
| `per_drawing`          | `PerDrawing`                            | resolves to overall class default (`Standard`) **and raises `tolerance_manual_review`** |

Manual-review resolution on the intake side should raise `tolerance_manual_review` when **any** of:

- `tolerance == per_drawing`, or
- `tolerance_critical == true`, or
- `tolerance_note` is non-empty.

> **Naming caution for the implementer:** the customer label for `precision` is "Precision (ISO 2768-f)", which normalises to the engine's internal **`Tight`** band — _not_ the engine's `Precision`/`UltraPrecision` bands. Map on the **token**, not the label, to avoid a mis-map. The note string is operator-facing context only and must never be parsed into a tightness or price.

## Compatibility & change control

- Adding a token is backward-compatible for the storefront but is a **breaking change for the intake mapping** — coordinate cross-repo and update this table in the same change.
- The default (`general`) and the empty/absent path are guaranteed inert so existing quotes and goldens do not move (ADR-0097 "inert-by-default").
