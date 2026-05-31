import type { PageServerLoad } from './$types';
import { listQuotes } from '$lib/server/quote-store';
import { QUOTE_STATUSES, QUOTE_STATUS_SET } from '$lib/server/quote-status';

export const prerender = false;
export const ssr = true;

export const load: PageServerLoad = async ({ url }) => {
	const statusFilter = url.searchParams.get('status');
	const active = statusFilter && QUOTE_STATUS_SET.has(statusFilter) ? statusFilter : null;
	const all = await listQuotes();
	const quotes = active ? all.filter((q) => q.status === active) : all;
	return {
		quotes,
		statuses: QUOTE_STATUSES,
		activeStatus: active,
		totalCount: all.length
	};
};
