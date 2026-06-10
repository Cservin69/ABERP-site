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
import { sendPricedReadyEmail } from '$lib/server/email';

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

/// S329 / 🔴2 — overwrite the priced PDF + flip `stock_alert` true on a
/// same-hash re-post. Shared by the pre-acceptance (`quoted`) relax (S323)
/// and the post-acceptance (`approved`) relax (S329). `statusLabel` is the
/// quote's current status — preserved across the re-render (the overlay
/// never changes terminality). Caller has already verified same-hash +
/// `meta.stock_alert` + `prior.stock_alert !== true`.
async function applyStockAlertRerender(
	id: string,
	existing: QuoteMetadata,
	prior: QuotePricing,
	meta: MetaPayload,
	pdfBlob: Blob,
	statusLabel: string
): Promise<Response> {
	const rerenderBytes = new Uint8Array(await pdfBlob.arrayBuffer());
	await writePricedPdfAtomic(id, rerenderBytes);

	const rerenderAt = new Date().toISOString();
	const rerenderPricing: QuotePricing = {
		// Preserve the original priced identity (received_at, hash). Only the
		// stock-status overlay and the artifact it lives on are refreshed; the
		// freshly-validated meta fields are taken from the re-post so the
		// stored record stays coherent with the re-rendered PDF.
		...prior,
		valid_until: meta.valid_until,
		breakdown_json: meta.breakdown_json,
		extractor_version: meta.extractor_version,
		engine_version: meta.engine_version,
		stock_alert: true
	};
	const rerendered: QuoteMetadata = {
		...existing,
		pricing: rerenderPricing,
		status_history: [
			...(existing.status_history ?? []),
			{
				at: rerenderAt,
				from: statusLabel,
				to: statusLabel,
				notes: `Stock-alert re-render: priced.pdf overwritten, stock_alert flipped true by ${meta.engine_version}`
			}
		]
	};
	await writeQuoteAtomic(id, rerendered);

	// Audit trace for the re-render. The customer HTML banner (/q/[id]) and
	// the re-rendered PDF both now reflect stock_alert:true; this is the only
	// server-side record that the false→true overwrite happened on a
	// same-hash post, so future investigation has a trail.
	console.info(
		'[priced] quote.priced_pdf_rerendered',
		JSON.stringify({
			event: 'quote.priced_pdf_rerendered',
			id,
			feature_graph_hash: meta.feature_graph_hash,
			status: statusLabel,
			stock_alert: true
		})
	);

	return json({ status: statusLabel, rerendered: true });
}

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
	let declaredLength: number | null = null;
	if (declared !== null) {
		const n = Number.parseInt(declared, 10);
		if (Number.isFinite(n)) {
			if (n > BODY_MAX_BYTES) {
				return json({ error: 'payload too large' }, { status: 413 });
			}
			declaredLength = n;
		}
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		// A multipart parse failure on a non-trivial declared body is the
		// fingerprint of upstream truncation — adapter-node's BODY_SIZE_LIMIT,
		// CloudFront, or nginx cut the body mid-stream and the multipart
		// boundaries no longer close. Surface this distinctly so the operator
		// knows where to look (S285 finding F1).
		if (declaredLength !== null && declaredLength > 512 * 1024) {
			return json(
				{
					error: 'body_truncated_by_proxy_or_adapter',
					hint:
						`multipart parse failed on a body declared ${declaredLength} bytes; ` +
						`check BODY_SIZE_LIMIT on the storefront process and any CloudFront/nginx ` +
						`body caps in front of it`
				},
				{ status: 413 }
			);
		}
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

	// State-machine check. Per ADR-0004 (+ S323/S329 stock-alert re-render relaxation):
	//   received | quoting              → proceed (new priced write)
	//   quoted, same hash, no flip      → 200 no-op (idempotent ABERP retry)
	//   quoted, same hash, false→true   → overwrite PDF + flip stock_alert (S323)
	//   quoted, new hash                → 409 already_priced_with_different_hash
	//   approved, same hash, false→true → overwrite PDF + flip stock_alert (S329 🔴2)
	//   approved, same hash, already true → 200 no-op (already flipped)
	//   approved, new hash / non-stock-alert post → 409
	//   rejected | invoiced            → 409 terminal_or_committed
	//
	// S329 / 🔴2 — `approved` is terminal for pricing identity but NOT for
	// the stock-status overlay. The trigger that arms the customer banner
	// fires AFTER the customer accepts (status `approved`); the re-render
	// daemon then re-posts the SAME geometry/pricing hash with
	// stock_alert:true. The S325 daemon could never deliver because the
	// only relax window was `quoted` (pre-acceptance) — mutually exclusive
	// with the post-acceptance trigger. Accept the same-hash, stock_alert
	// re-post here so the already-accepted customer still sees the downgrade.
	if (existing.status === 'approved' && meta.stock_alert) {
		const prior = existing.pricing;
		// No prior pricing on an approved quote is anomalous — nothing to
		// overwrite; keep the terminal 409 contract.
		if (!prior) {
			return json({ error: 'terminal_or_committed', status: existing.status }, { status: 409 });
		}
		if (prior.feature_graph_hash !== meta.feature_graph_hash) {
			return json(
				{
					error: 'already_priced_with_different_hash',
					feature_graph_hash: prior.feature_graph_hash ?? null
				},
				{ status: 409 }
			);
		}
		if (prior.stock_alert === true) {
			// Already flipped — idempotent (sticky, like the ABERP recompute).
			return json({ status: 'approved', idempotent: true });
		}
		return await applyStockAlertRerender(id, existing, prior, meta, pdfBlob, 'approved');
	}
	if (TERMINAL_STATES.has(existing.status)) {
		return json({ error: 'terminal_or_committed', status: existing.status }, { status: 409 });
	}
	if (existing.status === 'quoted') {
		const prior = existing.pricing;
		if (prior?.feature_graph_hash !== meta.feature_graph_hash) {
			return json(
				{
					error: 'already_priced_with_different_hash',
					feature_graph_hash: prior?.feature_graph_hash ?? null
				},
				{ status: 409 }
			);
		}
		// Same hash. Default is an idempotent no-op (an ABERP retry of the same
		// priced post). The one S323 exception is a *stock-alert re-render*:
		// after the customer is quoted, a stock downgrade may flip the alert.
		// ABERP re-renders priced.pdf with the banner and re-posts it carrying
		// the SAME feature_graph_hash (geometry/pricing are unchanged) but
		// stock_alert:true. The hash guards geometry/pricing identity, NOT the
		// stock-status overlay, so a false→true transition must overwrite the
		// stored PDF and flip pricing.stock_alert in place. A true→true (or any
		// *→false) same-hash post stays a no-op — sticky, mirroring the ABERP
		// recompute_stock_alert semantics, so the customer is never re-alerted
		// twice for the same downgrade.
		if (!(meta.stock_alert && prior.stock_alert !== true)) {
			return json({ status: 'quoted', idempotent: true });
		}

		return await applyStockAlertRerender(id, existing, prior, meta, pdfBlob, 'quoted');
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

	// Best-effort customer notification — the priced quote is already on disk
	// and visible at /q/<id>?t=<token>; a queue-write failure must not 500 the
	// ABERP writeback. Per ADR-0009 the storefront persists the request to the
	// email outbox and ABERP's poller picks it up on the next cycle.
	try {
		const r = await sendPricedReadyEmail(updated);
		if (r.status === 'failed') {
			console.error('[priced] ready-email enqueue failed:', r.reason);
		}
	} catch (err) {
		console.error('[priced] ready-email threw unexpectedly:', err);
	}

	return json({ status: 'quoted' });
};
