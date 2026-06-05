import { dev, building } from '$app/environment';
import { env } from '$env/dynamic/private';

/**
 * Single source of truth for the public-facing base URL of this deployment.
 *
 * Used by:
 *  - operator alert emails ("open in admin" link)
 *  - customer confirmation emails (signed /q/<id>?t=<token> link)
 *  - dynamic sitemap.xml + robots.txt
 *  - canonical + og:url + og:image meta tags
 *  - Origin allowlist for state-changing endpoints
 *
 * Reads ABERP_SITE_PUBLIC_URL at runtime via `$env/dynamic/private` so the
 * same build artifact can deploy to multiple hosts. Trailing slashes are
 * stripped so callers can append `/q/<id>` etc. without doubling.
 *
 * **Fail-closed in production (PR-R).** PR-Q originally fell back to a
 * hardcoded `https://abenerp.com` when the env var was missing — S249's
 * adversarial review (Finding 7) flagged that as a silent footgun: a
 * misconfigured staging box with no env would still pass `csrf.checkOrigin`
 * for prod-issued POSTs, because the Origin allowlist resolved to the prod
 * URL by default. After PR-R, an unset / blank `ABERP_SITE_PUBLIC_URL`
 * throws on first call when neither `dev` nor `building` is true (i.e. at
 * request time on a real server). The throw is lazy by design: SvelteKit
 * imports server modules eagerly, so a module-load throw would crash
 * unrelated dev-time tooling.
 *
 * The `building` carve-out preserves `npm run build`'s ability to prerender
 * `/`, `sitemap.xml`, and `robots.txt` in CI without first injecting the env
 * var — prerendered HTML that embeds the canonical URL is a content-hygiene
 * concern, not a security one, because the Origin check itself runs only at
 * request time and reads env fresh on every call. Pin `ABERP_SITE_PUBLIC_URL`
 * on every deployed host (see docs/deploy.md).
 *
 * Reconciles the historic split between ABERP_SITE_PUBLIC_URL (PR-K, operator
 * email) and ABERP_SITE_PUBLIC_BASE_URL (PR-L, customer email). The legacy
 * `_BASE_URL` name is no longer honoured.
 */
const BUILD_OR_DEV_DEFAULT = 'https://abenerp.com';

export function publicSiteUrl(): string {
	const raw = (env.ABERP_SITE_PUBLIC_URL ?? '').trim();
	if (!raw) {
		if (!dev && !building) {
			throw new Error('ABERP_SITE_PUBLIC_URL must be set in production. See docs/deploy.md.');
		}
		return BUILD_OR_DEV_DEFAULT;
	}
	return raw.replace(/\/+$/, '');
}
