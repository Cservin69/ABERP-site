import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { Actions, PageServerLoad } from './$types';
import { checkLogin, hasValidAdminCookie, setAdminCookie } from '$lib/server/auth';

export const prerender = false;
export const ssr = true;

export const load: PageServerLoad = async ({ cookies, url }) => {
	if (hasValidAdminCookie(cookies)) {
		const next = url.searchParams.get('next');
		throw redirect(303, next && next.startsWith('/admin/') ? next : '/admin/quotes');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, url }) => {
		const form = await request.formData();
		const submitted = form.get('token');
		if (typeof submitted !== 'string' || submitted.length === 0) {
			return fail(400, { error: 'Token required.' });
		}
		try {
			if (!checkLogin(submitted)) {
				return fail(401, { error: 'Invalid token.' });
			}
		} catch {
			return fail(503, { error: 'Server is not configured.' });
		}
		setAdminCookie(cookies, submitted, !dev);
		const next = url.searchParams.get('next');
		throw redirect(303, next && next.startsWith('/admin/') ? next : '/admin/quotes');
	}
};
