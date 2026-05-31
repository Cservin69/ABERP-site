import { error, fail, redirect } from '@sveltejs/kit';
import { stat } from 'node:fs/promises';
import type { Actions, PageServerLoad } from './$types';
import { quoteFilePath, readQuote, writeQuoteAtomic } from '$lib/server/quote-store';
import { QUOTE_STATUSES, isQuoteStatus } from '$lib/server/quote-status';

export const prerender = false;
export const ssr = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL in notes
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const NOTES_MAX = 2000;

export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;
	if (!UUID_RE.test(id)) throw error(400, 'Invalid id.');
	const quote = await readQuote(id);
	if (!quote) throw error(404, 'Quote not found.');

	const files = await Promise.all(
		quote.files.map(async (f) => {
			const fsPath = quoteFilePath(id, f.filename);
			let size = f.size_bytes;
			let exists = false;
			if (fsPath) {
				try {
					const st = await stat(fsPath);
					exists = st.isFile();
					if (exists) size = st.size;
				} catch {
					exists = false;
				}
			}
			return { ...f, size_bytes: size, exists };
		})
	);

	return {
		quote,
		files,
		statuses: QUOTE_STATUSES
	};
};

export const actions: Actions = {
	status: async ({ params, request }) => {
		const id = params.id ?? '';
		if (!UUID_RE.test(id)) return fail(400, { error: 'Invalid id.' });

		const form = await request.formData();
		const status = form.get('status');
		const notesRaw = form.get('notes');
		const notes = typeof notesRaw === 'string' ? notesRaw : '';

		if (!isQuoteStatus(status)) {
			return fail(400, { error: 'Invalid status value.' });
		}
		if (notes.length > NOTES_MAX) {
			return fail(400, { error: 'Notes too long.' });
		}
		if (HEADER_INJECTION_RE.test(notes)) {
			return fail(400, { error: 'Notes contains invalid characters.' });
		}

		const existing = await readQuote(id);
		if (!existing) return fail(404, { error: 'Not found.' });

		const updated = {
			...existing,
			status,
			status_history: [
				...(existing.status_history ?? []),
				{ at: new Date().toISOString(), from: existing.status, to: status, notes: notes.trim() }
			]
		};
		await writeQuoteAtomic(id, updated);
		throw redirect(303, `/admin/quotes/${id}`);
	}
};
