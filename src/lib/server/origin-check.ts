import { dev } from '$app/environment';
import { json } from '@sveltejs/kit';
import { publicSiteUrl } from './public-url';

/**
 * App-level Origin allowlist for state-changing endpoints.
 *
 * SvelteKit's built-in csrf.checkOrigin already rejects multipart/form POSTs
 * whose `Origin` header does not match `event.url.origin`. PR-Q layers a
 * stricter, explicit check on top so that:
 *
 *   1. The allowed origins are derived from `ABERP_SITE_PUBLIC_URL` via the
 *      shared `publicSiteUrl()` helper — the same single source of truth used
 *      by emails, sitemap, and og:url. A drift between the deployed env var
 *      and SvelteKit's per-request `event.url.origin` (the live-PR-P bug —
 *      see [[quote-csrf-origin]]) now fails closed against a documented value.
 *   2. Rejection returns a structured JSON 403 — `{ error: "origin_mismatch",
 *      expected, got }` — instead of SvelteKit's terse text response, so the
 *      `/api/quote` JSON contract (the form's fetch() reads .json()) and
 *      operator debugging both have something machine-readable to act on.
 *   3. In production the allowlist is exactly `publicSiteUrl()`. In dev the
 *      common local origins (`http://localhost:5173`, `http://127.0.0.1:5173`,
 *      `http://localhost:4173` for vite preview, plus their non-port variants)
 *      are also accepted so `vite dev` keeps working without per-developer env
 *      twiddling. The dev-only branch is gated on SvelteKit's `dev` flag,
 *      which is `false` in any production build regardless of NODE_ENV.
 *
 * Same-origin browser POSTs always carry an `Origin` header (per Fetch spec).
 * A missing header is treated as a same-origin (e.g. server-to-server) caller
 * and allowed; without this carve-out the internal `/api/quotes` admin tests
 * and any future server-side curl-from-the-box workflow would 403.
 *
 * Layered on top of csrf.checkOrigin — does NOT replace it.
 */

const DEV_ALLOWED = new Set([
	'http://localhost:5173',
	'http://127.0.0.1:5173',
	'http://localhost:4173',
	'http://127.0.0.1:4173',
	'http://localhost:3000',
	'http://127.0.0.1:3000'
]);

export interface OriginCheck {
	ok: boolean;
	expected: string[];
	got: string | null;
}

/**
 * Inspect the request's `Origin` header against the allowlist.
 * Pure: returns the verdict instead of throwing, so callers can choose
 * between a tailored JSON response (API routes) and `error(403, …)`
 * (form actions). Use `assertSameOrigin` for the common JSON-403 path.
 */
export function checkOrigin(request: Request): OriginCheck {
	const got = request.headers.get('origin');
	const expectedProd = publicSiteUrl();
	const expected = dev ? [expectedProd, ...DEV_ALLOWED] : [expectedProd];

	// No Origin header = not a browser-initiated cross-site POST (per Fetch).
	// SvelteKit's csrf.checkOrigin handles the browser case before us; an
	// absent header at this layer is server-side traffic and should pass.
	if (got === null || got.length === 0) {
		return { ok: true, expected, got: null };
	}

	return { ok: expected.includes(got), expected, got };
}

/**
 * Returns a `Response` (JSON 403) when the Origin check fails, or `null`
 * when the request may proceed. Pattern:
 *
 *   const reject = assertSameOrigin(request);
 *   if (reject) return reject;
 *
 * For SvelteKit form actions (which can't return arbitrary Responses), call
 * `checkOrigin` directly and convert to `error(403, …)` or `fail(403, …)`.
 */
export function assertSameOrigin(request: Request): Response | null {
	const verdict = checkOrigin(request);
	if (verdict.ok) return null;
	return json(
		{
			error: 'origin_mismatch',
			expected: verdict.expected,
			got: verdict.got
		},
		{ status: 403 }
	);
}
