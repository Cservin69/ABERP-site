// Server-side tolerance validation — the [[hulye-biztos]] backstop for the
// customer tolerance field. Mirrors cad-validate.ts: the same `ValidationResult`
// contract and the same guidance — a rejection never just says "rejected", it
// says what we received and what the allowed values are. The storefront only
// ever emits a closed-vocabulary token via a guided dropdown, so a value outside
// the set means a hand-crafted or replayed POST; /api/quote turns a failure here
// into a structured 400, exactly as it does for an out-of-format CAD upload.
//
// The closed vocabulary lives in $lib/tolerance (server-safe, also imported by
// the .svelte form + admin views) so there is one source of truth.

import { TOLERANCE_SCHEMES, isToleranceScheme } from '$lib/tolerance';

export type ValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate the customer's tolerance selection against the closed vocabulary.
 * Returns cad-validate's `ValidationResult` shape so the handler can mirror its
 * structured-error posture. The hostile-input echo is length-capped so a crafted
 * value can never blow up the error body.
 */
export function validateTolerance(value: string): ValidationResult {
	if (isToleranceScheme(value)) return { valid: true };
	const seen =
		value.length === 0
			? 'an empty value'
			: `\`${value.slice(0, 40)}${value.length > 40 ? '…' : ''}\``;
	return {
		valid: false,
		reason: `Tolerance must be one of ${TOLERANCE_SCHEMES.join(', ')} but received ${seen}.`
	};
}
