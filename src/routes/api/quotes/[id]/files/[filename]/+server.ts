import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { requireAdminAuth } from '$lib/server/auth';
import { quoteFilePath, readQuote } from '$lib/server/quote-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME_RE = /^[A-Za-z0-9._-]+$/;

export const GET: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	const filename = params.filename ?? '';
	if (!UUID_RE.test(id)) throw error(400, 'Invalid id.');
	if (!FILENAME_RE.test(filename) || filename.length > 200) {
		throw error(400, 'Invalid filename.');
	}

	const meta = await readQuote(id);
	if (!meta) throw error(404, 'Not found.');

	const allowed = meta.files.some((f) => f.filename === filename);
	if (!allowed) throw error(404, 'Not found.');

	const fsPath = quoteFilePath(id, filename);
	if (!fsPath) throw error(400, 'Invalid path.');

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
			'content-type': 'application/octet-stream',
			'content-length': String(size),
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'private, no-store'
		}
	});
};
