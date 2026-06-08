import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pricedPdfPath, readQuote } from '$lib/server/quote-store';
import { verifyQuoteToken } from '$lib/server/quote-token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer-facing indicative-quote PDF download, gated by the same HMAC status
 * token that protects /q/{id}?t=<token>. ABERP writes the file via the priced-
 * writeback (ADR-0004); this route streams it.
 *
 * Every failure path returns 404 so that probing for `?t=` does not reveal
 * whether the id exists, mirroring the +page.server.ts posture for /q/[id].
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const id = params.id ?? '';
	const token = url.searchParams.get('t');

	if (!UUID_RE.test(id)) throw error(404, 'Not found.');
	if (!token || !verifyQuoteToken(id, token)) throw error(404, 'Not found.');

	const meta = await readQuote(id);
	if (!meta) throw error(404, 'Not found.');
	if (!meta.pricing) throw error(404, 'Not found.');

	const fsPath = pricedPdfPath(id);
	if (!fsPath) throw error(404, 'Not found.');

	let size: number;
	try {
		const st = await stat(fsPath);
		if (!st.isFile()) throw error(404, 'Not found.');
		size = st.size;
	} catch {
		throw error(404, 'Not found.');
	}

	const nodeStream = createReadStream(fsPath);
	const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
	return new Response(webStream, {
		status: 200,
		headers: {
			'content-type': 'application/pdf',
			'content-length': String(size),
			'content-disposition': `inline; filename="quote-${id.slice(0, 8)}.pdf"`,
			'cache-control': 'private, no-store'
		}
	});
};
