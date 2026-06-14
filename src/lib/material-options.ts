// Pure, DOM-free helpers backing the Material typeahead combobox
// (S412). Kept out of the .svelte component so the filter/sort/option-building
// rules are unit-testable in the node-env vitest project (which excludes
// component specs). The combobox only ever *commits* a value drawn from this
// list — typing merely filters — so the backend's canonical-list validation in
// /api/quote ([[trust-code-not-operator]]) still gates every submission.

export type MaterialOption = {
	/** The value POSTed as `material` — a catalogue grade or a legacy key. */
	value: string;
	/** Human-facing label shown in the input + listbox. */
	label: string;
};

export type CatalogueMaterial = {
	grade: string;
	display_name: string;
	stock_status: string;
	lead_time_default_days: number;
};

// The two bookend choices that exist regardless of catalogue state. They sort
// alphabetically inline with the real grades (the brief wants a single sorted
// list, e.g. "… Monel 650, Not sure / ask us, Other, PEEK, …").
export const UNKNOWN_OPTION: MaterialOption = { value: 'unknown', label: 'Not sure / ask us' };
export const OTHER_OPTION: MaterialOption = { value: 'other', label: 'Other (note below)' };

// Generic fallback grades shown only when the live catalogue is cold/unreachable
// — mirrors the previous <select>'s fallback inventory exactly so we lose no
// option. Real grades come from /api/catalogue/materials (catalogue-fed per
// ADR-0003); we never hard-code shop grades here.
export const FALLBACK_OPTIONS: MaterialOption[] = [
	{ value: 'aluminum', label: 'Aluminum' },
	{ value: 'steel', label: 'Steel' },
	{ value: 'stainless', label: 'Stainless steel' },
	{ value: 'brass', label: 'Brass' },
	{ value: 'plastic', label: 'Plastic' }
];

/** Minimum characters typed before the list filters; below this the full list shows. */
export const MIN_FILTER_CHARS = 3;

/**
 * Build the full, alphabetically sorted option list: the `unknown` and `other`
 * bookends plus either the live catalogue grades or the static fallback. Sorted
 * case-insensitively by label so traversal order matches what the user reads.
 */
export function buildMaterialOptions(catalogue: CatalogueMaterial[]): MaterialOption[] {
	const middle: MaterialOption[] =
		catalogue.length > 0
			? catalogue.map((m) => ({ value: m.grade, label: m.display_name }))
			: FALLBACK_OPTIONS;
	const all = [UNKNOWN_OPTION, ...middle, OTHER_OPTION];
	return [...all].sort((a, b) =>
		a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
	);
}

/**
 * Filter the sorted options by the typed query. Fewer than MIN_FILTER_CHARS
 * (after trimming) → the full list, so an empty/short box shows everything.
 * At or above the threshold → case-insensitive substring match on the label, so
 * "alu" surfaces only the aluminium grades and "stainless" only the stainless
 * ones ([[hulye-biztos]]).
 */
export function filterMaterialOptions(options: MaterialOption[], query: string): MaterialOption[] {
	const q = query.trim().toLowerCase();
	if (q.length < MIN_FILTER_CHARS) return options;
	return options.filter((o) => o.label.toLowerCase().includes(q));
}

/**
 * Display text for a committed value. `unknown` renders as an empty box (the
 * placeholder carries "Not sure / ask us"), keeping the cleared state and the
 * default state visually identical. Any unknown value falls back to itself.
 */
export function labelForValue(options: MaterialOption[], value: string): string {
	if (value === UNKNOWN_OPTION.value) return '';
	return options.find((o) => o.value === value)?.label ?? '';
}
