import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { claimEntry, isValidEntryId, readEntry } from '$lib/server/email-outbox';

/**
 * POST /api/internal/email-queue/{id}/claim
 *
 * Atomic `queued → claimed` transition. Returns the full entry on success.
 * 409 if the entry is not in `queued/` (already claimed, already terminal, or
 * never existed) — the body distinguishes via the current `state` field when
 * the entry exists at all, or omits it when the id is unknown.
 *
 * Per ADR-0009: this endpoint is the load-bearing race guard. Two ABERP-side
 * pollers cannot both move the same entry forward; filesystem rename
 * atomicity is the single source of truth.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	if (!isValidEntryId(id)) return json({ error: 'invalid_entry_id' }, { status: 400 });

	const claimed = await claimEntry(id);
	if (claimed) return json(claimed);

	// claim() returned null — either the entry is in a non-queued state, or it
	// doesn't exist. Read across all states to give a useful 409.
	const current = await readEntry(id);
	if (!current) return json({ error: 'not_found' }, { status: 404 });
	return json({ error: 'not_claimable', state: current.state }, { status: 409 });
};
