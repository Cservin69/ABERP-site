import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';

const SIGNING_KEY = 'unit-test-signing-key-0123456789abcdef';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-pdf-'));

// Same module-load-timing trap as priced.spec.ts / catalogue-store.spec.ts:
// quote-store reads ABERP_SITE_QUOTE_DIR at load. Set it BEFORE the dynamic
// import inside loadHandler() runs.
process.env.ABERP_SITE_QUOTE_DIR = TMP_ROOT;

const { envState } = vi.hoisted(() => ({
	envState: {
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
	envState.QUOTE_STATUS_SIGNING_KEY = SIGNING_KEY;
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync(TMP_ROOT, { recursive: true });
});

const QUOTE_ID = '11111111-2222-3333-4444-555555555555';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);

function tokenFor(id: string): string {
	return createHmac('sha256', SIGNING_KEY).update(id).digest('base64url');
}

function seedQuote(id: string, opts: { withPricing: boolean; withPdf: boolean }): void {
	const dir = join(TMP_ROOT, id);
	mkdirSync(dir, { recursive: true });
	const metadata: Record<string, unknown> = {
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
		status: opts.withPricing ? 'quoted' : 'received',
		consent_at: '2026-06-06T10:00:00Z'
	};
	if (opts.withPricing) {
		metadata.pricing = {
			received_at: '2026-06-06T11:00:00Z',
			valid_until: '2099-12-31',
			breakdown_json: { total_eur: 123 },
			pdf_stored_at: 'priced.pdf',
			feature_graph_hash: 'blake3:abc',
			extractor_version: 'aberp-cad-extract@0.4.1',
			engine_version: 'aberp-quote-engine@0.7.0',
			stock_alert: false
		};
	}
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
	if (opts.withPdf) {
		writeFileSync(join(dir, 'priced.pdf'), Buffer.from(PDF_BYTES));
	}
}

async function loadHandler() {
	const mod = await import('./+server');
	return { GET: mod.GET };
}

function pdfReq(id: string, token: string | null): { params: { id: string }; url: URL } {
	const base = `http://localhost/api/quotes/${id}/pdf`;
	const url = new URL(token === null ? base : `${base}?t=${encodeURIComponent(token)}`);
	return { params: { id }, url };
}

async function statusOf(p: Response | Promise<Response>): Promise<number> {
	try {
		const r = await p;
		return r.status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

describe('GET /api/quotes/{id}/pdf', () => {
	it('404 when no token is presented (no enumeration leak)', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: true, withPdf: true });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(GET(pdfReq(QUOTE_ID, null) as any) as Promise<Response>)).toBe(404);
	});

	it('404 when token is invalid', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: true, withPdf: true });
		expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			await statusOf(GET(pdfReq(QUOTE_ID, 'definitely-not-a-token') as any) as Promise<Response>)
		).toBe(404);
	});

	it('404 when id is not a UUID', async () => {
		const { GET } = await loadHandler();
		expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			await statusOf(GET(pdfReq('garbage', tokenFor(QUOTE_ID)) as any) as Promise<Response>)
		).toBe(404);
	});

	it('404 when the quote does not exist', async () => {
		const { GET } = await loadHandler();
		expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			await statusOf(GET(pdfReq(QUOTE_ID, tokenFor(QUOTE_ID)) as any) as Promise<Response>)
		).toBe(404);
	});

	it('404 when the quote exists but has no pricing yet', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: false, withPdf: false });
		expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			await statusOf(GET(pdfReq(QUOTE_ID, tokenFor(QUOTE_ID)) as any) as Promise<Response>)
		).toBe(404);
	});

	it('404 when pricing is recorded but the PDF file is missing on disk', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: true, withPdf: false });
		expect(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			await statusOf(GET(pdfReq(QUOTE_ID, tokenFor(QUOTE_ID)) as any) as Promise<Response>)
		).toBe(404);
	});

	it('200 with content-type application/pdf when token + pricing + file all present', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: true, withPdf: true });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET(pdfReq(QUOTE_ID, tokenFor(QUOTE_ID)) as any);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(res.headers.get('content-length')).toBe(String(PDF_BYTES.length));
		expect(res.headers.get('cache-control')).toMatch(/no-store/);
		const disposition = res.headers.get('content-disposition') ?? '';
		expect(disposition).toContain('inline');
		expect(disposition).toContain(QUOTE_ID.slice(0, 8));
	});

	it('404 when a token signed for a different quote id is presented (no cross-quote reuse)', async () => {
		const { GET } = await loadHandler();
		seedQuote(QUOTE_ID, { withPricing: true, withPdf: true });
		const otherToken = tokenFor('99999999-2222-3333-4444-555555555555');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(GET(pdfReq(QUOTE_ID, otherToken) as any) as Promise<Response>)).toBe(404);
	});
});
