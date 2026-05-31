import type { LayoutServerLoad } from './$types';
import { hasValidAdminCookie } from '$lib/server/auth';
import { redirect } from '@sveltejs/kit';

export const prerender = false;
export const ssr = true;

export const load: LayoutServerLoad = async ({ cookies, url }) => {
	if (url.pathname === '/admin/login') {
		return { authed: hasValidAdminCookie(cookies) };
	}
	if (!hasValidAdminCookie(cookies)) {
		const next = url.pathname === '/admin' ? '' : `?next=${encodeURIComponent(url.pathname)}`;
		throw redirect(303, `/admin/login${next}`);
	}
	return { authed: true };
};
