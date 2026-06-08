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
