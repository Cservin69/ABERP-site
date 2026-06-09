import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { isValidEntryId, isValidIsoTimestamp, listQueued } from '$lib/server/email-outbox';

/**
 * GET /api/internal/email-queue?since=<iso>&after=<id>&limit=<n>
 *
 * Returns the storefront's queued (= "not yet claimed by ABERP") outbox
 * entries. ABERP's poll daemon calls this on its existing 60s cadence and
 * then `POST /claim` on each entry it intends to send.
 *
 * Auth: bearer ABERP_SITE_ADMIN_TOKEN (same secret as priced-writeback /
 * catalogue endpoints). No new token surface per ADR-0009.
 *
 * Pagination: ULID-based `?after=<id>` cursor. The default limit is 50;
 * `?limit=<n>` clamps to 200 in the store. We surface the cursor so a future
 * deeper-backlog poll can keep walking without losing data; today's traffic
 * fits one page comfortably.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAdminAuth(request);

	const sinceParam = url.searchParams.get('since');
	if (sinceParam !== null && !isValidIsoTimestamp(sinceParam)) {
		return json({ error: 'since must be an ISO timestamp' }, { status: 400 });
	}
	const afterParam = url.searchParams.get('after');
	if (afterParam !== null && !isValidEntryId(afterParam)) {
		return json({ error: 'after must be a valid entry id' }, { status: 400 });
	}
	const limitParam = url.searchParams.get('limit');
	let limit: number | undefined;
	if (limitParam !== null) {
		const n = Number.parseInt(limitParam, 10);
		if (!Number.isFinite(n) || n < 1) {
			return json({ error: 'limit must be a positive integer' }, { status: 400 });
		}
		limit = n;
	}

	const entries = await listQueued({
		since: sinceParam ?? undefined,
		after: afterParam ?? undefined,
		limit
	});
	return json({ entries });
};
