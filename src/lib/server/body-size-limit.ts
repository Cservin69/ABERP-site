/**
 * Boot-time check for adapter-node's BODY_SIZE_LIMIT.
 *
 * adapter-node parses this env var at server startup (handler.js:1279) and
 * defaults to 512 KB when unset. Two storefront endpoints carry request bodies
 * that comfortably exceed that:
 *
 *   - POST /api/quote                MAX_TOTAL_BYTES = 50 MB (customer CAD upload)
 *   - POST /api/quotes/[id]/priced   BODY_MAX_BYTES  =  6 MB (ABERP priced writeback, ADR-0004)
 *
 * adapter-node's cap fires BEFORE SvelteKit invokes the route handler, so the
 * in-handler caps cannot defend against a too-low BODY_SIZE_LIMIT — the request
 * is already 413'd at the adapter layer. The only defense is to make sure
 * BODY_SIZE_LIMIT is set ≥ the largest in-handler cap (= 50 MB).
 *
 * Single source of truth: this constant is referenced from
 *   .env.example
 *   bin/lightsail-bootstrap.sh   (writes /etc/aberp-site.env on first boot)
 *   docs/aws/aberp-site.service  (systemd Environment= fallback)
 *   docs/walkthroughs/end-to-end-auto-quote-test.md (Preflight 5)
 *
 * S285 review F1 — `docs/reviews/S285-adversarial-storefront-arc.md` — documented
 * the failure mode in detail.
 */
export const EXPECTED_BODY_SIZE_LIMIT = 52_428_800; // 50 MB

export type BodySizeLimitVerdict =
	| { ok: true; configured: number }
	| { ok: false; rawValue: string | undefined; reason: string; message: string };

export function verifyBodySizeLimit(
	rawValue: string | undefined = process.env.BODY_SIZE_LIMIT
): BodySizeLimitVerdict {
	const parsed = rawValue ? Number.parseInt(rawValue, 10) : NaN;
	if (!Number.isFinite(parsed) || parsed < EXPECTED_BODY_SIZE_LIMIT) {
		const reason = rawValue === undefined || rawValue === '' ? 'unset' : 'too-low';
		const displayed =
			rawValue === undefined || rawValue === '' ? '(unset, adapter-node default 524288)' : rawValue;
		const message =
			`[aberp-site] BODY_SIZE_LIMIT=${displayed} < ${EXPECTED_BODY_SIZE_LIMIT}. ` +
			`CAD uploads (POST /api/quote, 50 MB cap) and ABERP priced writebacks ` +
			`(POST /api/quotes/{id}/priced, 6 MB cap) larger than this will 413 at the ` +
			`adapter-node layer before the SvelteKit handler runs. ` +
			`Set BODY_SIZE_LIMIT=${EXPECTED_BODY_SIZE_LIMIT} in /etc/aberp-site.env or as ` +
			`a systemd Environment= line. See docs/reviews/S285-adversarial-storefront-arc.md ` +
			`finding F1 for the diagnosis.`;
		return { ok: false, rawValue, reason, message };
	}
	return { ok: true, configured: parsed };
}
