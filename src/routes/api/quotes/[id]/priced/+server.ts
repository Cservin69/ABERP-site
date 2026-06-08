import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import {
	readQuote,
	writeQuoteAtomic,
	writePricedPdfAtomic,
	type QuoteMetadata,
	type QuotePricing
} from '$lib/server/quote-store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^blake3:[0-9a-f]+$/;
const VERSION_RE = /^[\x20-\x7E]+$/;
const VERSION_MAX = 100;
// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL header-injection chars in version strings
const HEADER_INJECTION_RE = /[\r\n\x00]/;

const PDF_MAX_BYTES = 5 * 1024 * 1024;
// Total body cap leaves slack above the PDF cap for multipart overhead and
// the meta JSON. Tight enough to refuse a malformed PDF that's pretending to
// be a 5 MB part; loose enough that a real 5 MB PDF + a few KB of JSON fits.
const BODY_MAX_BYTES = 6 * 1024 * 1024;

const TERMINAL_STATES = new Set(['approved', 'rejected', 'invoiced']);

interface MetaPayload {
	breakdown_json: Record<string, unknown>;
	valid_until: string;
	feature_graph_hash: string;
	extractor_version: string;
	engine_version: string;
	stock_alert: boolean;
}

type MetaVerdict = { ok: true; value: MetaPayload } | { ok: false; reason: string };

function validateMeta(raw: unknown): MetaVerdict {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, reason: 'meta must be a JSON object' };
	}
	const m = raw as Record<string, unknown>;

	const breakdown_json = m.breakdown_json;
	if (!breakdown_json || typeof breakdown_json !== 'object' || Array.isArray(breakdown_json)) {
		return { ok: false, reason: 'breakdown_json must be a JSON object' };
	}

	const valid_until = m.valid_until;
	if (typeof valid_until !== 'string' || !DATE_RE.test(valid_until)) {
		return { ok: false, reason: 'valid_until must be YYYY-MM-DD' };
	}
	const today = new Date().toISOString().slice(0, 10);
	if (valid_until < today) {
		return { ok: false, reason: 'valid_until is in the past' };
	}

	const feature_graph_hash = m.feature_graph_hash;
	if (
		typeof feature_graph_hash !== 'string' ||
		feature_graph_hash.length === 0 ||
		feature_graph_hash.length > 200 ||
		!HASH_RE.test(feature_graph_hash)
	) {
		return { ok: false, reason: 'feature_graph_hash must match /^blake3:[0-9a-f]+$/' };
	}

	const extractor_version = m.extractor_version;
	if (
		typeof extractor_version !== 'string' ||
		extractor_version.length === 0 ||
		extractor_version.length > VERSION_MAX ||
		HEADER_INJECTION_RE.test(extractor_version) ||
		!VERSION_RE.test(extractor_version)
	) {
		return { ok: false, reason: 'extractor_version must be non-empty ASCII ≤ 100 chars' };
	}

	const engine_version = m.engine_version;
	if (
		typeof engine_version !== 'string' ||
		engine_version.length === 0 ||
		engine_version.length > VERSION_MAX ||
		HEADER_INJECTION_RE.test(engine_version) ||
		!VERSION_RE.test(engine_version)
	) {
		return { ok: false, reason: 'engine_version must be non-empty ASCII ≤ 100 chars' };
	}

	const stock_alert = m.stock_alert;
	if (typeof stock_alert !== 'boolean') {
		return { ok: false, reason: 'stock_alert must be a boolean' };
	}

	return {
		ok: true,
		value: {
			breakdown_json: breakdown_json as Record<string, unknown>,
			valid_until,
			feature_graph_hash,
			extractor_version,
			engine_version,
			stock_alert
		}
	};
}

export const POST: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	if (!UUID_RE.test(id)) return json({ error: 'Invalid id.' }, { status: 400 });

	const declared = request.headers.get('content-length');
	if (declared !== null) {
		const n = Number.parseInt(declared, 10);
		if (Number.isFinite(n) && n > BODY_MAX_BYTES) {
			return json({ error: 'payload too large' }, { status: 413 });
		}
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'failed to parse multipart body' }, { status: 400 });
	}

	const metaPart = form.get('meta');
	if (typeof metaPart !== 'string') {
		return json({ error: 'meta part missing or not text' }, { status: 400 });
	}
	let metaRaw: unknown;
	try {
		metaRaw = JSON.parse(metaPart);
	} catch {
		return json({ error: 'meta is not valid JSON' }, { status: 400 });
	}
	const verdict = validateMeta(metaRaw);
	if (!verdict.ok) return json({ error: verdict.reason }, { status: 400 });

	const pdfPart = form.get('pdf');
	if (!pdfPart || typeof pdfPart === 'string') {
		return json({ error: 'pdf part missing or not a file' }, { status: 400 });
	}
	const pdfBlob = pdfPart as Blob;
	if (pdfBlob.type !== 'application/pdf') {
		return json({ error: 'pdf part must be application/pdf' }, { status: 400 });
	}
	if (pdfBlob.size > PDF_MAX_BYTES) {
		return json({ error: 'pdf exceeds 5 MB cap' }, { status: 413 });
	}
	if (pdfBlob.size === 0) {
		return json({ error: 'pdf is empty' }, { status: 400 });
	}

	const existing = await readQuote(id);
	if (!existing) return json({ error: 'Not found.' }, { status: 404 });

	const meta = verdict.value;

	// State-machine check. Per ADR-0004:
	//   received | quoting → proceed (new priced write)
	//   quoted, same hash  → 200 no-op (idempotent ABERP retry)
	//   quoted, new hash   → 409 already_priced_with_different_hash
	//   terminal           → 409 terminal_or_committed
	if (TERMINAL_STATES.has(existing.status)) {
		return json({ error: 'terminal_or_committed', status: existing.status }, { status: 409 });
	}
	if (existing.status === 'quoted') {
		if (existing.pricing?.feature_graph_hash === meta.feature_graph_hash) {
			return json({ status: 'quoted', idempotent: true });
		}
		return json(
			{
				error: 'already_priced_with_different_hash',
				feature_graph_hash: existing.pricing?.feature_graph_hash ?? null
			},
			{ status: 409 }
		);
	}
	if (existing.status !== 'received' && existing.status !== 'quoting') {
		return json({ error: 'unexpected source state', status: existing.status }, { status: 409 });
	}

	const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
	await writePricedPdfAtomic(id, pdfBytes);

	const now = new Date().toISOString();
	const pricing: QuotePricing = {
		received_at: now,
		valid_until: meta.valid_until,
		breakdown_json: meta.breakdown_json,
		pdf_stored_at: 'priced.pdf',
		feature_graph_hash: meta.feature_graph_hash,
		extractor_version: meta.extractor_version,
		engine_version: meta.engine_version,
		stock_alert: meta.stock_alert
	};

	const fromStatus = existing.status;
	const updated: QuoteMetadata = {
		...existing,
		status: 'quoted',
		pricing,
		status_history: [
			...(existing.status_history ?? []),
			{
				at: now,
				from: fromStatus,
				to: 'quoted',
				notes: `Priced by ${meta.engine_version}, valid_until ${meta.valid_until}`
			}
		]
	};
	await writeQuoteAtomic(id, updated);

	return json({ status: 'quoted' });
};
