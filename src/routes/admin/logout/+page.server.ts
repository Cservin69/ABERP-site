import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clearAdminCookie } from '$lib/server/auth';

export const prerender = false;
export const ssr = true;

export const load: PageServerLoad = async () => {
	throw redirect(303, '/admin/login');
};

export const actions: Actions = {
	// Intentionally NOT guarded by requireAdminCookieOrError. Clearing a cookie
	// that doesn't exist is a harmless no-op, and an unauthenticated POST to
	// /admin/logout should not 401 — it should look like "logged out, here is
	// the login page." See jsdoc on requireAdminCookieOrRedirect in auth.ts.
	default: async ({ cookies }) => {
		clearAdminCookie(cookies);
		throw redirect(303, '/admin/login');
	}
};
