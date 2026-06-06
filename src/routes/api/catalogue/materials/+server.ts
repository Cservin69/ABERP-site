import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import {
	readCatalogueSnapshot,
	validateSnapshotBody,
	writeCatalogueAtomic,
	type CatalogueSnapshot
} from '$lib/server/catalogue-store';

const MAX_BODY_BYTES = 1024 * 1024;

export const PUT: RequestHandler = async ({ request }) => {
	requireAdminAuth(request);

	const declared = request.headers.get('content-length');
	if (declared !== null) {
		const n = Number.parseInt(declared, 10);
		if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
			return json({ error: 'payload too large' }, { status: 413 });
		}
	}

	let raw: string;
	try {
		raw = await request.text();
	} catch {
		return json({ error: 'failed to read request body' }, { status: 400 });
	}
	if (raw.length > MAX_BODY_BYTES) {
		return json({ error: 'payload too large' }, { status: 413 });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return json({ error: 'body is not valid JSON' }, { status: 400 });
	}

	const verdict = validateSnapshotBody(parsed);
	if (!verdict.ok) {
		return json({ error: verdict.reason }, { status: 400 });
	}

	const snapshot: CatalogueSnapshot = {
		materials: verdict.materials,
		received_at: new Date().toISOString()
	};
	await writeCatalogueAtomic(snapshot);

	return json({ received_count: snapshot.materials.length });
};

export const GET: RequestHandler = async () => {
	const snap = await readCatalogueSnapshot();
	const body: { materials: CatalogueSnapshot['materials']; received_at?: string } = snap
		? { materials: snap.materials, received_at: snap.received_at }
		: { materials: [] };
	return json(body, {
		headers: { 'Cache-Control': 'public, max-age=60' }
	});
};
