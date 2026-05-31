import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clearAdminCookie } from '$lib/server/auth';

export const prerender = false;
export const ssr = true;

export const load: PageServerLoad = async () => {
	throw redirect(303, '/admin/login');
};

export const actions: Actions = {
	default: async ({ cookies }) => {
		clearAdminCookie(cookies);
		throw redirect(303, '/admin/login');
	}
};
