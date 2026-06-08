import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve as pathResolve, join } from 'node:path';
import { requireAdminAuth } from '$lib/server/auth';
import { QUOTE_STATUS_SET } from '$lib/server/quote-status';

const QUOTE_DIR = process.env.ABERP_SITE_QUOTE_DIR ?? './data/quotes';

/**
 * GET /api/quotes — list quotes for the ABERP intake daemon (S211 era contract).
 *
 * Query params:
 *   ?status=<state>   restrict to quotes in the given lifecycle state.
 *                     For S294/PR-08 the daemon polls `status=approved` after
 *                     a customer commits a typed-ACCEPT on /q/{id}/accept,
 *                     which the accept handler (S283) transitions `quoted →
 *                     approved` with `accepted_at` + `acceptance_signature_ts`
 *                     stamped in the same atomic write.
 *   ?since=<iso8601>  incremental-poll cursor. When `status=approved`, filters
 *                     on `accepted_at >= since`; otherwise on `received_at >=
 *                     since`. Backwards-compatible: omitting it returns every
 *                     match (legacy behaviour).
 *
 * Response shape: `{ quotes: QuoteMetadata[] }` — the raw on-disk metadata
 * documents. ABERP's daemon (Ajánlatok tab intake) consumes the full record;
 * keeping the contract as "whatever metadata.json holds" means new typed
 * fields (acceptance audit, stock_alert, …) reach ABERP without a schema
 * negotiation per ADR-0004 §"Versioning posture". Sort order: most-recent
 * `received_at` first.
 */
export const GET: RequestHandler = async ({ url, request }) => {
	requireAdminAuth(request);

	const statusFilter = url.searchParams.get('status');
	if (statusFilter && !QUOTE_STATUS_SET.has(statusFilter)) {
		return json({ error: 'Invalid status filter.' }, { status: 400 });
	}

	const sinceRaw = url.searchParams.get('since');
	let sinceMs: number | null = null;
	if (sinceRaw !== null && sinceRaw !== '') {
		const parsed = Date.parse(sinceRaw);
		if (!Number.isFinite(parsed)) {
			return json({ error: 'Invalid since cursor (must be ISO 8601).' }, { status: 400 });
		}
		sinceMs = parsed;
	}
	// For status=approved the meaningful cursor is `accepted_at` (when the
	// customer typed ACCEPT). For every other status no acceptance stamp
	// exists yet, so `received_at` is the only stable monotonic timestamp.
	const sinceField: 'accepted_at' | 'received_at' =
		statusFilter === 'approved' ? 'accepted_at' : 'received_at';

	const root = pathResolve(QUOTE_DIR);

	let dirEntries: string[];
	try {
		const s = await stat(root);
		if (!s.isDirectory()) return json({ quotes: [] });
		dirEntries = await readdir(root);
	} catch {
		return json({ quotes: [] });
	}

	const quotes: Record<string, unknown>[] = [];
	for (const name of dirEntries) {
		const sub = join(root, name);
		if (!pathResolve(sub).startsWith(root)) continue;
		let st;
		try {
			st = await stat(sub);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;

		const metaPath = join(sub, 'metadata.json');
		try {
			const raw = await readFile(metaPath, 'utf8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (statusFilter && parsed.status !== statusFilter) continue;
			if (sinceMs !== null) {
				const candidate = parsed[sinceField];
				if (typeof candidate !== 'string') continue;
				const rowMs = Date.parse(candidate);
				if (!Number.isFinite(rowMs) || rowMs < sinceMs) continue;
			}
			quotes.push(parsed);
		} catch {
			continue;
		}
	}

	quotes.sort((a, b) => {
		const at = typeof a.received_at === 'string' ? a.received_at : '';
		const bt = typeof b.received_at === 'string' ? b.received_at : '';
		return bt.localeCompare(at);
	});

	return json({ quotes });
};
