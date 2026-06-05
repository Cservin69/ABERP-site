import type { LayoutServerLoad } from './$types';
import { publicSiteUrl } from '$lib/server/public-url';

/**
 * The root server load exposes the public-facing base URL so every page can
 * render canonical / og:url / og:image meta tags off the same env-derived
 * source rather than the historic hardcoded `https://abenerp.com` literal in
 * `app.html`. Returning a string (not the function itself) keeps it
 * serialisable across the SSR boundary.
 */
export const load: LayoutServerLoad = () => {
	return {
		publicSiteUrl: publicSiteUrl()
	};
};
