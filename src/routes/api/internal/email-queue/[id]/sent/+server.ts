import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { isValidEntryId, markSent, readEntry } from '$lib/server/email-outbox';

// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL header-injection chars in audit_id
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const AUDIT_ID_MAX = 200;

/**
 * POST /api/internal/email-queue/{id}/sent
 *
 * Body: { audit_id: string } — ABERP's email-send audit event id (the
 * `email.relayed_storefront` event row id in the ABERP ledger).
 *
 * Transitions `claimed → sent`. Idempotent: a replay against an already-sent
 * entry returns 200 with the existing record (first writer wins on
 * audit_id — see email-outbox.ts `markSent`).
 *
 * 409 if the entry is not in `claimed/` (still queued, failed, never existed).
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
	const { audit_id } = body as { audit_id?: unknown };
	if (typeof audit_id !== 'string' || audit_id.length === 0) {
		return json({ error: 'audit_id is required' }, { status: 400 });
	}
	if (audit_id.length > AUDIT_ID_MAX) {
		return json({ error: `audit_id exceeds ${AUDIT_ID_MAX} chars` }, { status: 400 });
	}
	if (HEADER_INJECTION_RE.test(audit_id)) {
		return json({ error: 'audit_id contains invalid characters' }, { status: 400 });
	}

	try {
		const sent = await markSent(id, audit_id);
		return json(sent);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === 'not_claimed') {
			const current = await readEntry(id);
			if (!current) return json({ error: 'not_found' }, { status: 404 });
			return json({ error: 'not_claimed', state: current.state }, { status: 409 });
		}
		// invalid_entry_id is caught above by isValidEntryId — any other throw
		// is genuinely unexpected. Surface as 500 so a future bug is visible
		// rather than silently swallowed.
		console.error('[email-queue] markSent threw unexpectedly:', err);
		return json({ error: 'internal_error' }, { status: 500 });
	}
};
