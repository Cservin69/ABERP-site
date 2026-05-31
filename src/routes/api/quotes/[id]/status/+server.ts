import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { readQuote, writeQuoteAtomic, type QuoteMetadata } from '$lib/server/quote-store';
import { isQuoteStatus } from '$lib/server/quote-status';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL injection in notes
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const NOTES_MAX = 2000;

export const POST: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	if (!UUID_RE.test(id)) return json({ error: 'Invalid id.' }, { status: 400 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body.' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') {
		return json({ error: 'Invalid body.' }, { status: 400 });
	}

	const { status, notes } = body as { status?: unknown; notes?: unknown };

	if (!isQuoteStatus(status)) {
		return json({ error: 'Invalid status value.' }, { status: 400 });
	}

	let notesStr = '';
	if (notes !== undefined && notes !== null) {
		if (typeof notes !== 'string')
			return json({ error: 'Notes must be a string.' }, { status: 400 });
		if (notes.length > NOTES_MAX) return json({ error: 'Notes too long.' }, { status: 400 });
		if (HEADER_INJECTION_RE.test(notes)) {
			return json({ error: 'Notes contains invalid characters.' }, { status: 400 });
		}
		notesStr = notes.trim();
	}

	const existing = await readQuote(id);
	if (!existing) return json({ error: 'Not found.' }, { status: 404 });

	const from = existing.status;
	const to = status;
	const updated: QuoteMetadata = {
		...existing,
		status: to,
		status_history: [
			...(existing.status_history ?? []),
			{ at: new Date().toISOString(), from, to, notes: notesStr }
		]
	};

	await writeQuoteAtomic(id, updated);
	return json(updated);
};
