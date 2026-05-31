import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { readQuote } from '$lib/server/quote-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);
	const id = params.id ?? '';
	if (!UUID_RE.test(id)) return json({ error: 'Invalid id.' }, { status: 400 });
	const meta = await readQuote(id);
	if (!meta) return json({ error: 'Not found.' }, { status: 404 });
	return json(meta);
};
