import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ADMIN_TOKEN = 'unit-test-admin-token';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-quotes-list-'));

// quote-store / list endpoint read ABERP_SITE_QUOTE_DIR at module load via
// process.env — must be set before any import drags the handler in.
process.env.ABERP_SITE_QUOTE_DIR = TMP_ROOT;

const { envState } = vi.hoisted(() => ({
	envState: {
		ABERP_SITE_ADMIN_TOKEN: 'unit-test-admin-token'
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
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync(TMP_ROOT, { recursive: true });
});

interface SeedExtras {
	receivedAt?: string;
	acceptedAt?: string;
	signatureTs?: string;
	pricing?: Record<string, unknown>;
}

function seedQuote(id: string, status: string, extras: SeedExtras = {}): void {
	const dir = join(TMP_ROOT, id);
	mkdirSync(dir, { recursive: true });
	const metadata: Record<string, unknown> = {
		id,
		received_at: extras.receivedAt ?? '2026-06-06T10:00:00Z',
		contact: { name: 'Test Customer', email: 'test@example.com', company: '' },
		request: {
			material_preference: '6061-T6',
			quantity: 5,
			deadline: '2026-07-01',
			notes: ''
		},
		files: [],
		status,
		consent_at: '2026-06-06T10:00:00Z'
	};
	if (extras.pricing) {
		metadata.pricing = extras.pricing;
	}
	if (extras.acceptedAt) {
		metadata.accepted_at = extras.acceptedAt;
	}
	if (extras.signatureTs) {
		metadata.acceptance_signature_ts = extras.signatureTs;
	}
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

function pricingFor(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		received_at: '2026-06-07T10:00:00Z',
		valid_until: '2099-12-31',
		breakdown_json: { total_eur: 123.45, currency: 'EUR' },
		pdf_stored_at: 'priced.pdf',
		feature_graph_hash: 'blake3:abc',
		extractor_version: 'v1',
		engine_version: 'v1',
		stock_alert: false,
		...over
	};
}

function listReq(query: string, opts: { token?: string } = {}): Request {
	const headers: Record<string, string> = {};
	if (opts.token !== '') {
		headers['authorization'] = `Bearer ${opts.token ?? ADMIN_TOKEN}`;
	}
	return new Request(`http://localhost/api/quotes${query}`, { method: 'GET', headers });
}

async function loadHandler() {
	const mod = await import('./+server');
	return { GET: mod.GET };
}

async function statusOf(p: Response | Promise<Response>): Promise<number> {
	try {
		const r = await p;
		return r.status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

const APPROVED_ID = '11111111-2222-3333-4444-555555555555';
const QUOTED_ID = '22222222-3333-4444-5555-666666666666';
const RECEIVED_ID = '33333333-4444-5555-6666-777777777777';

describe('GET /api/quotes — auth', () => {
	it('rejects missing Authorization header with 401', async () => {
		const { GET } = await loadHandler();
		const req = listReq('?status=approved', { token: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(GET({ url: new URL(req.url), request: req } as any))).toBe(401);
	});

	it('returns 503 when ABERP_SITE_ADMIN_TOKEN is unset', async () => {
		delete envState.ABERP_SITE_ADMIN_TOKEN;
		const { GET } = await loadHandler();
		const req = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(GET({ url: new URL(req.url), request: req } as any))).toBe(503);
	});

	it('rejects an unknown status filter with 400', async () => {
		const { GET } = await loadHandler();
		const req = listReq('?status=bogus');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(400);
	});

	it('rejects a malformed since cursor with 400', async () => {
		const { GET } = await loadHandler();
		const req = listReq('?status=approved&since=not-a-date');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(400);
	});
});

describe('GET /api/quotes?status=approved — PR-08 polling contract', () => {
	it('happy path: a quote flipped to approved appears with the ABERP-required fields', async () => {
		// Seed an approved quote as the accept handler would persist it.
		seedQuote(APPROVED_ID, 'approved', {
			receivedAt: '2026-06-06T10:00:00Z',
			acceptedAt: '2026-06-08T12:34:56Z',
			signatureTs: '2026-07-08T00:00:00.000Z',
			pricing: pricingFor()
		});
		const { GET } = await loadHandler();
		const req = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotes: Record<string, unknown>[] };
		expect(body.quotes).toHaveLength(1);
		const row = body.quotes[0];
		// ID + contact (ABERP intake fields).
		expect(row.id).toBe(APPROVED_ID);
		const contact = row.contact as { name: string; email: string };
		expect(contact.email).toBe('test@example.com');
		expect(contact.name).toBe('Test Customer');
		// Request shape (material grade, quantity, needed-by).
		const request = row.request as {
			material_preference: string;
			quantity: number;
			deadline: string;
		};
		expect(request.material_preference).toBe('6061-T6');
		expect(request.quantity).toBe(5);
		expect(request.deadline).toBe('2026-07-01');
		// Pricing sub-record carries valid_until + opaque engine breakdown.
		const pricing = row.pricing as { valid_until: string; breakdown_json: { currency: string } };
		expect(pricing.valid_until).toBe('2099-12-31');
		expect(pricing.breakdown_json.currency).toBe('EUR');
		// Acceptance audit trio set by the accept handler.
		expect(row.accepted_at).toBe('2026-06-08T12:34:56Z');
		expect(row.acceptance_signature_ts).toBe('2026-07-08T00:00:00.000Z');
		expect(row.status).toBe('approved');
	});

	it('excludes pre-accept (status=quoted) rows from the approved listing', async () => {
		seedQuote(QUOTED_ID, 'quoted', { pricing: pricingFor() });
		seedQuote(APPROVED_ID, 'approved', {
			acceptedAt: '2026-06-08T12:34:56Z',
			signatureTs: '2026-07-08T00:00:00.000Z',
			pricing: pricingFor()
		});
		seedQuote(RECEIVED_ID, 'received');
		const { GET } = await loadHandler();
		const req = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotes: { id: string; status: string }[] };
		expect(body.quotes).toHaveLength(1);
		expect(body.quotes[0].id).toBe(APPROVED_ID);
		expect(body.quotes[0].status).toBe('approved');
	});

	it('idempotent: a re-poll for the same status surfaces the approved quote once per row', async () => {
		seedQuote(APPROVED_ID, 'approved', {
			acceptedAt: '2026-06-08T12:34:56Z',
			signatureTs: '2026-07-08T00:00:00.000Z',
			pricing: pricingFor()
		});
		const { GET } = await loadHandler();
		const req1 = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res1 = await GET({ url: new URL(req1.url), request: req1 } as any);
		const body1 = (await res1.json()) as { quotes: { id: string }[] };
		const req2 = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res2 = await GET({ url: new URL(req2.url), request: req2 } as any);
		const body2 = (await res2.json()) as { quotes: { id: string }[] };
		expect(body1.quotes).toHaveLength(1);
		expect(body2.quotes).toHaveLength(1);
		expect(body1.quotes[0].id).toBe(body2.quotes[0].id);
	});

	it('since cursor on status=approved filters by accepted_at (not received_at)', async () => {
		// Seed two approved quotes with different acceptance times.
		seedQuote(APPROVED_ID, 'approved', {
			receivedAt: '2026-06-06T10:00:00Z',
			acceptedAt: '2026-06-08T08:00:00Z',
			signatureTs: '2026-07-08T00:00:00.000Z',
			pricing: pricingFor()
		});
		seedQuote('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'approved', {
			receivedAt: '2026-06-06T11:00:00Z',
			acceptedAt: '2026-06-08T14:00:00Z',
			signatureTs: '2026-07-08T00:00:00.000Z',
			pricing: pricingFor()
		});
		const { GET } = await loadHandler();
		// Cursor between the two acceptance times — only the later one passes.
		const req = listReq('?status=approved&since=2026-06-08T12:00:00Z');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotes: { id: string }[] };
		expect(body.quotes).toHaveLength(1);
		expect(body.quotes[0].id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
	});

	it('approved row without accepted_at is excluded when since is set', async () => {
		// Defensive: legacy row that was stored as approved but never went
		// through the HMAC accept handler (no accepted_at). With `since`,
		// the cursor field is missing and the row drops.
		seedQuote(APPROVED_ID, 'approved', { pricing: pricingFor() });
		const { GET } = await loadHandler();
		const req = listReq('?status=approved&since=2026-01-01T00:00:00Z');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotes: unknown[] };
		expect(body.quotes).toHaveLength(0);
	});

	it('returns an empty array when no quotes exist and the data dir is absent', async () => {
		// beforeEach wipes TMP_ROOT and recreates the empty dir, but to test
		// the "no dir at all" branch, remove it.
		rmSync(TMP_ROOT, { recursive: true, force: true });
		const { GET } = await loadHandler();
		const req = listReq('?status=approved');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({ url: new URL(req.url), request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { quotes: unknown[] };
		expect(body.quotes).toEqual([]);
	});
});
