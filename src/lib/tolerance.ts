// Pure, DOM-free, server-safe tolerance vocabulary backing the storefront
// /quote tolerance dropdown and any copy that needs the human labels. Kept out
// of $lib/server so .svelte components (the quote form, the admin detail page)
// can import the labels/options without tripping SvelteKit's server-only-import
// guard; the server-side validator ($lib/server/tolerance-validate) imports the
// same closed vocabulary, so there is a single source of truth.
//
// Per ADR-0097 (Q6) the customer surface is a small guided closed set — NO raw
// ISO 286 IT-grades and NO free-form ± (customers garble those, and over-asking
// loses quotes). The operator owns precision downstream. The wire contract this
// vocabulary feeds is documented in docs/contracts/quote-tolerance.md.

/** A value POSTed as `tolerance` paired with its human label (one dropdown row). */
export type ToleranceOption = {
	value: ToleranceScheme;
	label: string;
};

/**
 * Closed, customer-facing tolerance vocabulary in display order. The storefront
 * only ever emits one of these tokens; everything downstream treats the set as
 * exhaustive. `general` is the default and is byte-for-byte the pre-tolerance
 * behaviour (ISO 2768-m ↔ the engine's existing `Standard` band — ADR-0097 Q1).
 */
export const TOLERANCE_SCHEMES = ['general', 'precision', 'per_drawing'] as const;
export type ToleranceScheme = (typeof TOLERANCE_SCHEMES)[number];

/** Applied when the field is absent — back-compat with pre-tolerance submissions. */
export const TOLERANCE_DEFAULT: ToleranceScheme = 'general';

/** Cap for the optional, descriptive-only critical-features note (operator review only). */
export const TOLERANCE_NOTE_MAX = 500;

/** Human-facing labels — single source of truth for the form and the admin view. */
export const TOLERANCE_LABELS: Record<ToleranceScheme, string> = {
	general: 'General machining (ISO 2768-m)',
	precision: 'Precision (ISO 2768-f)',
	per_drawing: 'High precision — specify on drawing'
};

/**
 * Dropdown options in display order, `general` first (the default). The form
 * renders these verbatim; no jargon beyond the parenthetical ISO class.
 */
export const TOLERANCE_OPTIONS: ToleranceOption[] = TOLERANCE_SCHEMES.map((value) => ({
	value,
	label: TOLERANCE_LABELS[value]
}));

const ALLOWED: ReadonlySet<string> = new Set(TOLERANCE_SCHEMES);

/** True iff `v` is exactly one of the closed-vocabulary tokens. */
export function isToleranceScheme(v: string): v is ToleranceScheme {
	return ALLOWED.has(v);
}

/**
 * Does this scheme route the job to operator manual review? `per_drawing` always
 * does (ADR-0097: PerDrawing is never silently priced — the engine flags for a
 * human instead of inventing a tightness it cannot read). The Defense intake
 * additionally raises review when the customer marks critical features or leaves
 * a note; that resolution lives on the intake side, not here.
 */
export function requiresManualReview(scheme: ToleranceScheme): boolean {
	return scheme === 'per_drawing';
}

/**
 * Human label for a stored/POSTed value. Absent/null ⇒ the default (`general`).
 * An in-vocab token maps to its label; anything else (only reachable on legacy
 * or hand-crafted data, since the API validates) echoes the raw value so the
 * operator still sees something truthful.
 */
export function toleranceLabel(value: string | null | undefined): string {
	const v = value ?? TOLERANCE_DEFAULT;
	return isToleranceScheme(v) ? TOLERANCE_LABELS[v] : v;
}
