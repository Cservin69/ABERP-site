import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve as pathResolve, join } from 'node:path';

const QUOTE_DIR = process.env.ABERP_SITE_QUOTE_DIR ?? './data/quotes';
const ALLOWED_STATUS = new Set(['received', 'quoted', 'approved', 'rejected']);

// NOTE (Phase 2 v1): NO AUTHENTICATION. This is an operator-pull endpoint
// intended for localhost-only use. Production deployment MUST add an API key
// or mTLS before exposing this to the network. Tracked for the 2.0 cutover
// when ABERP becomes the consumer.

export const GET: RequestHandler = async ({ url }) => {
	const statusFilter = url.searchParams.get('status');
	if (statusFilter && !ALLOWED_STATUS.has(statusFilter)) {
		return json({ error: 'Invalid status filter.' }, { status: 400 });
	}

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
			quotes.push(parsed);
		} catch {
			// skip directories without a valid metadata.json
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
