import type { RequestHandler } from './$types';
import { publicSiteUrl } from '$lib/server/public-url';

export const prerender = true;

/**
 * Dynamic sitemap so the host comes from `ABERP_SITE_PUBLIC_URL` rather than a
 * static literal. Prerendered (`prerender = true`) so it ships as a flat file
 * in the build output and CloudFront caches it like any other static asset —
 * the env-var read happens once at build time and the resulting XML is the
 * same shape as the legacy `static/sitemap.xml`.
 */
export const GET: RequestHandler = () => {
	const base = publicSiteUrl();
	const lastmod = '2026-05-31';
	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
\t<url>
\t\t<loc>${base}/</loc>
\t\t<lastmod>${lastmod}</lastmod>
\t\t<changefreq>monthly</changefreq>
\t\t<priority>1.0</priority>
\t</url>
</urlset>
`;
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': 'public, max-age=3600'
		}
	});
};
