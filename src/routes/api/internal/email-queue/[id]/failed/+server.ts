import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { isValidEntryId, markFailed, readEntry } from '$lib/server/email-outbox';

// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL header-injection chars in error classification
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const ERROR_CLASS_MAX = 100;
const ERROR_DETAIL_MAX = 2000;

/**
 * POST /api/internal/email-queue/{id}/failed
 *
 * Body: { error_class: string, error_detail: string }
 *
 * Transitions `claimed → failed`. Idempotent on replay (first writer wins on
 * last_error). 409 if not currently claimed.
 *
 * v1 ships no DLQ — failed entries sit on disk for operator inspection. The
 * storefront does NOT auto-retry; ABERP owns the "did this actually send"
 * question.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	if (!isValidEntryId(id)) return json({ error: 'invalid_entry_id' }, { status: 400 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid_json' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') {
		return json({ error: 'body must be a JSON object' }, { status: 400 });
	}
	const { error_class, error_detail } = body as {
		error_class?: unknown;
		error_detail?: unknown;
	};
	if (typeof error_class !== 'string' || error_class.length === 0) {
		return json({ error: 'error_class is required' }, { status: 400 });
	}
	if (error_class.length > ERROR_CLASS_MAX) {
		return json({ error: `error_class exceeds ${ERROR_CLASS_MAX} chars` }, { status: 400 });
	}
	if (HEADER_INJECTION_RE.test(error_class)) {
		return json({ error: 'error_class contains invalid characters' }, { status: 400 });
	}
	if (typeof error_detail !== 'string') {
		return json({ error: 'error_detail must be a string' }, { status: 400 });
	}
	if (error_detail.length > ERROR_DETAIL_MAX) {
		return json({ error: `error_detail exceeds ${ERROR_DETAIL_MAX} chars` }, { status: 400 });
	}
	if (HEADER_INJECTION_RE.test(error_detail)) {
		return json({ error: 'error_detail contains invalid characters' }, { status: 400 });
	}

	try {
		const failed = await markFailed(id, error_class, error_detail);
		return json(failed);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === 'not_claimed') {
			const current = await readEntry(id);
			if (!current) return json({ error: 'not_found' }, { status: 404 });
			return json({ error: 'not_claimed', state: current.state }, { status: 409 });
		}
		console.error('[email-queue] markFailed threw unexpectedly:', err);
		return json({ error: 'internal_error' }, { status: 500 });
	}
};
