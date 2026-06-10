import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ADMIN_TOKEN = 'unit-test-admin-token';
const SIGNING_KEY = 'unit-test-signing-key-0123456789abcdef';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-priced-'));

// IMPORTANT: ABERP_SITE_QUOTE_DIR is read by quote-store.ts at MODULE LOAD via
// `process.env.ABERP_SITE_QUOTE_DIR ?? './data/quotes'`. Static `import` calls
// are hoisted above any top-level statements, so we MUST set the env var BEFORE
// touching the store — and we MUST use dynamic `import()` inside the tests so
// the timing actually works. The catalogue-store.spec.ts comments cover the
// same trap (S277 / PR-02 finding).
process.env.ABERP_SITE_QUOTE_DIR = TMP_ROOT;

const { envState } = vi.hoisted(() => ({
	envState: {
		ABERP_SITE_ADMIN_TOKEN: 'unit-test-admin-token',
		QUOTE_STATUS_SIGNING_KEY: 'unit-test-signing-key-0123456789abcdef'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

beforeEach(() => {
	envState.ABERP_SITE_ADMIN_TOKEN = ADMIN_TOKEN;
	envState.QUOTE_STATUS_SIGNING_KEY = SIGNING_KEY;
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync(TMP_ROOT, { recursive: true });
});

const FUTURE_DATE = '2099-12-31';
const QUOTE_ID = '11111111-2222-3333-4444-555555555555';

function seedQuote(id: string, status: string, extra: Record<string, unknown> = {}): void {
	const dir = join(TMP_ROOT, id);
	mkdirSync(dir, { recursive: true });
	const metadata = {
		id,
		received_at: '2026-06-06T10:00:00Z',
		contact: { name: 'Test', email: 'test@example.com', company: '' },
		request: {
			material_preference: 'AL_6061_T6',
			quantity: 5,
			deadline: null,
			notes: ''
		},
		files: [],
		status,
		consent_at: '2026-06-06T10:00:00Z',
		...extra
	};
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

function readSeededQuote(id: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(TMP_ROOT, id, 'metadata.json'), 'utf8'));
}

function defaultMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		breakdown_json: { total_eur: 123.45, currency: 'EUR' },
		valid_until: FUTURE_DATE,
		feature_graph_hash: 'blake3:1a2b3c4d5e6f',
		extractor_version: 'aberp-cad-extract@0.4.1',
		engine_version: 'aberp-quote-engine@0.7.0',
		stock_alert: false,
		...overrides
	};
}

function buildForm(meta: Record<string, unknown>, pdfBytes: Buffer): FormData {
	const fd = new FormData();
	fd.set('meta', JSON.stringify(meta));
	// `Buffer<ArrayBufferLike>` does not narrow to `BlobPart` under strict TS even
	// though the Node runtime accepts it. The cast is a TS-only concession.
	const blob = new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' });
	fd.set('pdf', blob, 'quote.pdf');
	return fd;
}

function pricedReq(
	id: string,
	form: FormData | string,
	opts?: { token?: string; contentType?: string; contentLength?: string }
): Request {
	const headers: Record<string, string> = {};
	if (opts?.token !== '') {
		headers['authorization'] = `Bearer ${opts?.token ?? ADMIN_TOKEN}`;
	}
	if (opts?.contentLength) headers['content-length'] = opts.contentLength;
	const init: RequestInit = { method: 'POST', headers };
	if (typeof form === 'string') {
		headers['content-type'] = opts?.contentType ?? 'text/plain';
		init.body = form;
	} else {
		init.body = form;
	}
	return new Request(`http://localhost/api/quotes/${id}/priced`, init);
}

async function loadHandler() {
	const mod = await import('./+server');
	return { POST: mod.POST };
}

async function statusOf(p: Response | Promise<Response>): Promise<number> {
	try {
		const r = await p;
		return r.status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

const SMALL_PDF = Buffer.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a);

describe('POST /api/quotes/{id}/priced — auth', () => {
	it('rejects missing Authorization header with 401', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF), { token: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(401);
	});

	it('rejects wrong bearer with 401', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF), { token: 'nope' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(401);
	});

	it('returns 503 when ABERP_SITE_ADMIN_TOKEN is unset', async () => {
		delete envState.ABERP_SITE_ADMIN_TOKEN;
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(503);
	});
});

describe('POST /api/quotes/{id}/priced — input validation', () => {
	it('rejects a malformed UUID with 400', async () => {
		const { POST } = await loadHandler();
		const req = pricedReq('not-a-uuid', buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: 'not-a-uuid' }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects a non-multipart body with 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, '{}', { contentType: 'application/json' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects when content-length exceeds the body cap with 413', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF), {
			contentLength: String(7 * 1024 * 1024)
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(413);
	});

	it('rejects missing meta part with 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const fd = new FormData();
		fd.set('pdf', new Blob([SMALL_PDF], { type: 'application/pdf' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects meta that is not valid JSON', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const fd = new FormData();
		fd.set('meta', '{not json');
		fd.set('pdf', new Blob([SMALL_PDF], { type: 'application/pdf' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects breakdown_json that is not a JSON object', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ breakdown_json: [1, 2, 3] }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects valid_until in the past with 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ valid_until: '2000-01-01' }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects malformed valid_until with 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta({ valid_until: 'soon' }), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects feature_graph_hash without blake3 prefix', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ feature_graph_hash: 'sha256:abcdef' }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects extractor_version with CR/LF injection', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ extractor_version: 'good\r\nBcc: a@b.c' }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects non-boolean stock_alert', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: 'true' }), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects missing pdf part', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const fd = new FormData();
		fd.set('meta', JSON.stringify(defaultMeta()));
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects pdf part with wrong content-type', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const fd = new FormData();
		fd.set('meta', JSON.stringify(defaultMeta()));
		fd.set('pdf', new Blob([SMALL_PDF], { type: 'text/plain' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects empty pdf', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const fd = new FormData();
		fd.set('meta', JSON.stringify(defaultMeta()));
		fd.set('pdf', new Blob([Buffer.alloc(0)], { type: 'application/pdf' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects pdf above 5 MB cap', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const big = new ArrayBuffer(5 * 1024 * 1024 + 100);
		const view = new Uint8Array(big);
		view[0] = 0x25;
		view[1] = 0x50;
		view[2] = 0x44;
		view[3] = 0x46;
		const fd = new FormData();
		fd.set('meta', JSON.stringify(defaultMeta()));
		fd.set('pdf', new Blob([big], { type: 'application/pdf' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(413);
	});

	it('accepts a 4 MB pdf — exercises the handler well above the adapter-node default 512 KB', async () => {
		// Regression gate for S285 finding F1. The handler's design cap is 5 MB
		// (PDF_MAX_BYTES); the adapter-node default is 512 KB. This test calls
		// the handler directly, so the adapter cap is not exercised — but it
		// proves the handler itself accepts a body well above the adapter
		// default. If a future change accidentally lowers the handler's cap
		// below 4 MB, the priced-writeback contract (ADR-0004, 5 MB PDF design
		// max) is silently broken; this test catches that.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const pdfBytes = new ArrayBuffer(4 * 1024 * 1024);
		const view = new Uint8Array(pdfBytes);
		view[0] = 0x25;
		view[1] = 0x50;
		view[2] = 0x44;
		view[3] = 0x46;
		view[4] = 0x2d;
		const fd = new FormData();
		fd.set('meta', JSON.stringify(defaultMeta()));
		fd.set('pdf', new Blob([pdfBytes], { type: 'application/pdf' }), 'quote.pdf');
		const req = pricedReq(QUOTE_ID, fd);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const onDisk = readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'));
		expect(onDisk.length).toBe(4 * 1024 * 1024);
	});

	it('returns 413 body_truncated_by_proxy_or_adapter on parse failure with a large declared content-length', async () => {
		// Defense-in-depth diagnostic for S285 F1. When adapter-node, CloudFront,
		// or nginx truncates a request mid-multipart-stream, the multipart
		// boundaries no longer close and FormData parsing throws. We can't
		// rebuild the body from inside the handler, but we can distinguish
		// "client sent garbage" (small declared length, parse fails — 400)
		// from "upstream truncation" (large declared length, parse fails — 413
		// with a hint pointing the operator at BODY_SIZE_LIMIT). Simulate the
		// truncation by sending a deliberately malformed multipart body whose
		// declared content-length matches the truncation scenario.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const malformed = '--boundary-marker\r\nContent-Disposition: form-data; name="pdf"\r\n\r\n';
		const req = new Request(`http://localhost/api/quotes/${QUOTE_ID}/priced`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${ADMIN_TOKEN}`,
				'content-type': 'multipart/form-data; boundary=boundary-marker',
				'content-length': String(2 * 1024 * 1024)
			},
			body: malformed
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string; hint?: string };
		expect(body.error).toBe('body_truncated_by_proxy_or_adapter');
		expect(body.hint).toContain('BODY_SIZE_LIMIT');
	});

	it('returns plain 400 on parse failure with a small declared content-length (not truncation)', async () => {
		// Symmetric to the truncation test: a small body that fails to parse
		// is just client garbage and stays a 400. This keeps the truncation
		// signal sharp — operators only see the 413+hint when the body was
		// actually large enough for an upstream cap to be the culprit.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = new Request(`http://localhost/api/quotes/${QUOTE_ID}/priced`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${ADMIN_TOKEN}`,
				'content-type': 'multipart/form-data; boundary=nope',
				'content-length': '64'
			},
			body: 'not actually multipart'
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(400);
	});
});

describe('POST /api/quotes/{id}/priced — happy path + persistence', () => {
	it('writes pdf, persists pricing, flips received → quoted, appends status_history', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const meta = defaultMeta();
		const req = pricedReq(QUOTE_ID, buildForm(meta, SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe('quoted');

		expect(existsSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'))).toBe(true);
		const onDisk = readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'));
		expect(onDisk.length).toBe(SMALL_PDF.length);

		const after = readSeededQuote(QUOTE_ID);
		expect(after.status).toBe('quoted');
		expect(after.pricing).toBeDefined();
		const pricing = after.pricing as Record<string, unknown>;
		expect(pricing.valid_until).toBe(FUTURE_DATE);
		expect(pricing.feature_graph_hash).toBe(meta.feature_graph_hash);
		expect(pricing.stock_alert).toBe(false);
		expect(pricing.pdf_stored_at).toBe('priced.pdf');
		expect(pricing.breakdown_json).toEqual(meta.breakdown_json);

		const history = after.status_history as { from: string; to: string; notes: string }[];
		expect(history).toHaveLength(1);
		expect(history[0].from).toBe('received');
		expect(history[0].to).toBe('quoted');
		expect(history[0].notes).toContain(meta.engine_version as string);
	});

	it('also accepts a quoting → quoted transition (ABERP wrote the intermediate state)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoting');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const after = readSeededQuote(QUOTE_ID);
		expect(after.status).toBe('quoted');
		const history = after.status_history as { from: string; to: string }[];
		expect(history[0].from).toBe('quoting');
	});

	it('persists stock_alert: true verbatim into the pricing record (addendum 2 customer-side)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: req } as any);
		const after = readSeededQuote(QUOTE_ID);
		expect((after.pricing as { stock_alert: boolean }).stock_alert).toBe(true);
	});

	it('passes opaque breakdown_json through verbatim (addendum 1 fields live here, untouched)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const breakdown = {
			total_eur: 250,
			requires_5_axis: true,
			thin_wall_present: true,
			line_items: [{ name: 'setup', cost_eur: 50 }]
		};
		const req = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ breakdown_json: breakdown }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const after = readSeededQuote(QUOTE_ID);
		expect((after.pricing as { breakdown_json: unknown }).breakdown_json).toEqual(breakdown);
	});
});

describe('POST /api/quotes/{id}/priced — state machine + idempotency', () => {
	it('returns 404 when the quote does not exist', async () => {
		const { POST } = await loadHandler();
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(404);
	});

	it('same hash on an already-quoted quote returns 200 idempotent and does not mutate', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const meta = defaultMeta();
		const req1 = pricedReq(QUOTE_ID, buildForm(meta, SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: req1 } as any);
		const after1 = readSeededQuote(QUOTE_ID);
		const history1 = after1.status_history as unknown[];

		const req2 = pricedReq(QUOTE_ID, buildForm(meta, SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req2 } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; idempotent?: boolean };
		expect(body.status).toBe('quoted');
		expect(body.idempotent).toBe(true);

		const after2 = readSeededQuote(QUOTE_ID);
		expect((after2.status_history as unknown[]).length).toBe(history1.length);
	});

	it('different hash on an already-quoted quote returns 409', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req1 = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: req1 } as any);

		const req2 = pricedReq(
			QUOTE_ID,
			buildForm(defaultMeta({ feature_graph_hash: 'blake3:deadbeef' }), SMALL_PDF)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req2 } as any);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('already_priced_with_different_hash');
	});

	it('returns 409 terminal_or_committed on an approved quote', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('terminal_or_committed');
	});

	it('returns 409 terminal_or_committed on an invoiced quote', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'invoiced');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});

	it('returns 409 terminal_or_committed on a rejected quote', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'rejected');
		const req = pricedReq(QUOTE_ID, buildForm(defaultMeta(), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});
});

// S323 — stock-alert re-render relaxation. After a quote is `quoted`, a stock
// downgrade lets ABERP re-render priced.pdf with the addendum-2 banner and
// re-POST it carrying the SAME feature_graph_hash but stock_alert:true. The
// hash guards geometry/pricing identity, not the stock-status overlay, so a
// false→true same-hash post must overwrite the PDF and flip the flag — while
// every other same-hash post stays an idempotent no-op and acceptance stays a
// hard 409.
describe('POST /api/quotes/{id}/priced — S323 stock-alert re-render', () => {
	// A distinct PDF body so an overwrite is observable on disk (different bytes,
	// different length than SMALL_PDF).
	const BANNER_PDF = Buffer.from('%PDF-1.4\n% stock-alert re-rendered banner pdf\n', 'utf8');

	it('s323_priced_stock_alert_flip_overwrites_pdf_and_flag', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');

		// First price: stock_alert:false → quoted, original PDF on disk.
		const meta = defaultMeta({ stock_alert: false });
		const first = pricedReq(QUOTE_ID, buildForm(meta, SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: first } as any);
		const histBefore = (readSeededQuote(QUOTE_ID).status_history as unknown[]).length;
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);

		// Stock-alert re-render: SAME hash, stock_alert:true, fresh PDF body.
		const rerender = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: rerender } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; rerendered?: boolean };
		expect(body.status).toBe('quoted');
		expect(body.rerendered).toBe(true);

		// PDF overwritten with the re-rendered (banner) bytes.
		const onDisk = readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'));
		expect(onDisk.length).toBe(BANNER_PDF.length);
		expect(onDisk.equals(BANNER_PDF)).toBe(true);

		// Flag flipped + audit history appended; hash and status preserved.
		const after = readSeededQuote(QUOTE_ID);
		expect(after.status).toBe('quoted');
		const pricing = after.pricing as Record<string, unknown>;
		expect(pricing.stock_alert).toBe(true);
		expect(pricing.feature_graph_hash).toBe(meta.feature_graph_hash);
		const hist = after.status_history as { from: string; to: string; notes: string }[];
		expect(hist.length).toBe(histBefore + 1);
		expect(hist[hist.length - 1].notes).toContain('Stock-alert re-render');
	});

	it('s323_priced_stock_alert_already_true_returns_noop', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');

		// First price already carries stock_alert:true.
		const first = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: first } as any);
		const histBefore = (readSeededQuote(QUOTE_ID).status_history as unknown[]).length;

		// A second same-hash stock_alert:true post must NOT re-flip / re-write
		// (sticky). Use a different PDF body to prove the no-op didn't overwrite.
		const second = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: second } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { idempotent?: boolean; rerendered?: boolean };
		expect(body.idempotent).toBe(true);
		expect(body.rerendered).toBeUndefined();

		// PDF unchanged (still the original SMALL_PDF), no extra history.
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);
		expect((readSeededQuote(QUOTE_ID).status_history as unknown[]).length).toBe(histBefore);
	});

	it('s323_priced_same_hash_stock_alert_false_still_noop', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');

		// First price: stock_alert:false → quoted.
		const meta = defaultMeta({ stock_alert: false });
		const first = pricedReq(QUOTE_ID, buildForm(meta, SMALL_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await POST({ params: { id: QUOTE_ID }, request: first } as any);
		const histBefore = (readSeededQuote(QUOTE_ID).status_history as unknown[]).length;

		// Same-hash, stock_alert STILL false — the existing idempotency must be
		// preserved (regression guard for the relaxation).
		const second = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: false }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: second } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { idempotent?: boolean; rerendered?: boolean };
		expect(body.idempotent).toBe(true);
		expect(body.rerendered).toBeUndefined();

		// PDF untouched, flag still false, no extra history.
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);
		const after = readSeededQuote(QUOTE_ID);
		expect((after.pricing as { stock_alert: boolean }).stock_alert).toBe(false);
		expect((after.status_history as unknown[]).length).toBe(histBefore);
	});

	it('s323_priced_post_acceptance_non_stock_alert_still_409', async () => {
		const { POST } = await loadHandler();
		// `approved` is the post-acceptance status. A NON-stock-alert post
		// (stock_alert:false) must still be a hard 409 — the S329 relax is
		// scoped to the stock-status overlay only, not a free overwrite of an
		// accepted quote.
		seedQuote(QUOTE_ID, 'approved', {
			pricing: {
				received_at: '2026-06-06T11:00:00Z',
				valid_until: FUTURE_DATE,
				breakdown_json: { total_eur: 123.45, currency: 'EUR' },
				pdf_stored_at: 'priced.pdf',
				feature_graph_hash: 'blake3:1a2b3c4d5e6f',
				extractor_version: 'aberp-cad-extract@0.4.1',
				engine_version: 'aberp-quote-engine@0.7.0',
				stock_alert: false
			},
			accepted_at: '2026-06-07T09:00:00Z'
		});
		writeFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'), SMALL_PDF);

		const post = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: false }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: post } as any);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('terminal_or_committed');

		// Acceptance gate intact: PDF and flag untouched.
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);
		const after = readSeededQuote(QUOTE_ID);
		expect((after.pricing as { stock_alert: boolean }).stock_alert).toBe(false);
	});
});

// S329 / 🔴2 — post-acceptance stock-alert re-render. The customer-banner
// trigger fires AFTER acceptance (status `approved`), which the S323 relax
// (scoped to `quoted`) could never reach. Accept the same-hash,
// stock_alert:true re-post against an `approved` quote so the already-
// accepted customer still sees the downgrade — while a different hash, an
// already-flipped flag, and non-stock-alert posts keep their guards.
describe('POST /api/quotes/{id}/priced — S329 post-acceptance stock-alert re-render', () => {
	const BANNER_PDF = Buffer.from('%PDF-1.4\n% s329 post-accept banner pdf\n', 'utf8');

	function approvedPrior(stockAlert: boolean): Record<string, unknown> {
		return {
			received_at: '2026-06-06T11:00:00Z',
			valid_until: FUTURE_DATE,
			breakdown_json: { total_eur: 123.45, currency: 'EUR' },
			pdf_stored_at: 'priced.pdf',
			feature_graph_hash: 'blake3:1a2b3c4d5e6f',
			extractor_version: 'aberp-cad-extract@0.4.1',
			engine_version: 'aberp-quote-engine@0.7.0',
			stock_alert: stockAlert
		};
	}

	it('s329_priced_post_accept_stock_alert_flip_allowed', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved', {
			pricing: approvedPrior(false),
			accepted_at: '2026-06-07T09:00:00Z'
		});
		writeFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'), SMALL_PDF);
		const histBefore =
			(readSeededQuote(QUOTE_ID).status_history as unknown[] | undefined)?.length ?? 0;

		// Same hash, stock_alert:true, fresh banner PDF.
		const rerender = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: rerender } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; rerendered?: boolean };
		expect(body.status).toBe('approved');
		expect(body.rerendered).toBe(true);

		// PDF overwritten with the banner bytes; status stays approved; flag flipped.
		const onDisk = readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'));
		expect(onDisk.equals(BANNER_PDF)).toBe(true);
		const after = readSeededQuote(QUOTE_ID);
		expect(after.status).toBe('approved');
		const pricing = after.pricing as Record<string, unknown>;
		expect(pricing.stock_alert).toBe(true);
		expect(pricing.feature_graph_hash).toBe('blake3:1a2b3c4d5e6f');
		const hist = after.status_history as { from: string; to: string; notes: string }[];
		expect(hist.length).toBe(histBefore + 1);
		expect(hist[hist.length - 1].from).toBe('approved');
		expect(hist[hist.length - 1].to).toBe('approved');
		expect(hist[hist.length - 1].notes).toContain('Stock-alert re-render');
	});

	it('s329_priced_post_accept_already_true_returns_noop', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved', {
			pricing: approvedPrior(true),
			accepted_at: '2026-06-07T09:00:00Z'
		});
		writeFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'), SMALL_PDF);

		const second = pricedReq(QUOTE_ID, buildForm(defaultMeta({ stock_alert: true }), BANNER_PDF));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: second } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			idempotent?: boolean;
			rerendered?: boolean;
		};
		expect(body.idempotent).toBe(true);
		expect(body.rerendered).toBeUndefined();
		// PDF untouched (sticky).
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);
	});

	it('s329_priced_post_accept_different_hash_409', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved', {
			pricing: approvedPrior(false),
			accepted_at: '2026-06-07T09:00:00Z'
		});
		writeFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'), SMALL_PDF);

		const post = pricedReq(
			QUOTE_ID,
			buildForm(
				defaultMeta({ stock_alert: true, feature_graph_hash: 'blake3:deadbeef' }),
				BANNER_PDF
			)
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: post } as any);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('already_priced_with_different_hash');
		// Untouched.
		expect(readFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf')).length).toBe(SMALL_PDF.length);
		expect((readSeededQuote(QUOTE_ID).pricing as { stock_alert: boolean }).stock_alert).toBe(false);
	});
});
