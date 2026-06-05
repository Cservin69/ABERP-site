import { env } from '$env/dynamic/private';

/**
 * Single source of truth for the public-facing base URL of this deployment.
 *
 * Used by:
 *  - operator alert emails ("open in admin" link)
 *  - customer confirmation emails (signed /q/<id>?t=<token> link)
 *  - dynamic sitemap.xml + robots.txt
 *  - canonical + og:url + og:image meta tags
 *
 * Reads ABERP_SITE_PUBLIC_URL at runtime via `$env/dynamic/private` so the
 * same build artifact can deploy to multiple hosts. Falls back to the
 * production canonical (`https://abenerp.com`) so local-dev tests and the
 * first-deploy moment work without explicit config. Trailing slashes are
 * stripped so callers can append `/q/<id>` etc. without doubling.
 *
 * Reconciles the historic split between ABERP_SITE_PUBLIC_URL (PR-K, operator
 * email) and ABERP_SITE_PUBLIC_BASE_URL (PR-L, customer email) — both pointed
 * at the same value in /etc/aberp-site.env, and divergence between them was a
 * latent footgun (a staging box pinning one but not the other would email
 * cross-environment links). The legacy `_BASE_URL` name is no longer honoured
 * by this module; deploys must set ABERP_SITE_PUBLIC_URL.
 */
const DEFAULT = 'https://abenerp.com';

export function publicSiteUrl(): string {
	const raw = (env.ABERP_SITE_PUBLIC_URL ?? '').trim() || DEFAULT;
	return raw.replace(/\/+$/, '');
}
