import type { RequestHandler } from './$types';
import { publicSiteUrl } from '$lib/server/public-url';

export const prerender = true;

/**
 * Dynamic robots.txt — same shape as the legacy `static/robots.txt`, but the
 * Sitemap pointer is constructed from `ABERP_SITE_PUBLIC_URL` so a staging
 * deploy advertises its own sitemap host rather than the production literal.
 */
export const GET: RequestHandler = () => {
	const base = publicSiteUrl();
	const body = `# allow crawling everything by default
User-agent: *
Disallow:

Sitemap: ${base}/sitemap.xml
`;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=3600'
		}
	});
};
