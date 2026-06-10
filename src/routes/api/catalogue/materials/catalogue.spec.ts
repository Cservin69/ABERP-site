import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const TOKEN = 'unit-test-admin-token';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-cat-endpoint-'));

const { envState } = vi.hoisted(() => ({
	envState: { ABERP_SITE_ADMIN_TOKEN: 'unit-test-admin-token' } as {
		ABERP_SITE_ADMIN_TOKEN?: string;
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

process.env.ABERP_SITE_CATALOGUE_DIR = TMP_ROOT;

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

beforeEach(() => {
	envState.ABERP_SITE_ADMIN_TOKEN = TOKEN;
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

async function loadHandlers() {
	const mod = await import('./+server');
	return { PUT: mod.PUT, GET: mod.GET };
}

function bearerReq(body: string, opts?: { token?: string; contentLength?: string }): Request {
	const headers: Record<string, string> = {
		'content-type': 'application/json'
	};
	if (opts?.token !== '') {
		headers['authorization'] = `Bearer ${opts?.token ?? TOKEN}`;
	}
	if (opts?.contentLength) headers['content-length'] = opts.contentLength;
	return new Request('http://localhost/api/catalogue/materials', {
		method: 'PUT',
		headers,
		body
	});
}

const goodBody = (n = 1): string => {
	const grades = ['AL_6061_T6', 'TI_6AL_4V', 'INCONEL_718', 'SS_316L', 'BRASS_360'];
	const materials = Array.from({ length: n }, (_, i) => ({
		grade: grades[i % grades.length],
		display_name: `Material ${i}`,
		stock_status: 'in_stock' as const,
		lead_time_default_days: 0
	}));
	return JSON.stringify({ materials });
};

async function statusOf(p: Promise<Response>): Promise<number> {
	try {
		const r = await p;
		return r.status;
	} catch (err) {
		// SvelteKit's `error(...)` helper throws HttpError; surface its `status`.
		return (err as { status: number }).status;
	}
}

describe('PUT /api/catalogue/materials', () => {
	it('rejects missing Authorization header with 401', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq(goodBody(1), { token: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(PUT({ request: req } as any) as Promise<Response>)).toBe(401);
	});

	it('rejects wrong bearer with 401', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq(goodBody(1), { token: 'wrong' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(PUT({ request: req } as any) as Promise<Response>)).toBe(401);
	});

	it('returns 503 when ABERP_SITE_ADMIN_TOKEN is unset', async () => {
		delete envState.ABERP_SITE_ADMIN_TOKEN;
		const { PUT } = await loadHandlers();
		const req = bearerReq(goodBody(1));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(PUT({ request: req } as any) as Promise<Response>)).toBe(503);
	});

	it('accepts a valid snapshot and returns received_count', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq(goodBody(2));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { received_count: number };
		expect(body.received_count).toBe(2);
	});

	it('accepts an empty catalogue (= delete-all)', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq(JSON.stringify({ materials: [] }));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: req } as any);
		expect(res.status).toBe(200);
	});

	it('rejects malformed JSON with 400', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq('{not json}');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: req } as any);
		expect(res.status).toBe(400);
	});

	it('one bad row rejects the entire snapshot atomically', async () => {
		const { PUT, GET } = await loadHandlers();
		// Seed a known-good snapshot first.
		const seed = await PUT({
			request: bearerReq(goodBody(2))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any);
		expect(seed.status).toBe(200);

		const bad = JSON.stringify({
			materials: [
				{
					grade: 'AL_6061_T6',
					display_name: 'OK',
					stock_status: 'in_stock',
					lead_time_default_days: 0
				},
				{ grade: 'invalid lowercase', display_name: '', stock_status: 'in_stock' }
			]
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: bearerReq(bad) } as any);
		expect(res.status).toBe(400);

		// The known-good seed survives — partial replace would have wiped it.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const after = await GET({} as any);
		const body = (await after.json()) as { materials: { grade: string }[] };
		expect(body.materials).toHaveLength(2);
	});

	it('rejects body > 1 MB via Content-Length header (no parse)', async () => {
		const { PUT } = await loadHandlers();
		const req = bearerReq(goodBody(1), { contentLength: String(2 * 1024 * 1024) });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: req } as any);
		expect(res.status).toBe(413);
	});

	it('rejects body > 1 MB by raw length even when Content-Length is missing', async () => {
		const { PUT } = await loadHandlers();
		// Build a >1MB body of valid-looking padding. Use a giant display_name
		// on a single row to push the parsed body past the cap.
		// (display_name has a 200-char per-row cap; instead, make many rows.)
		const materials = Array.from({ length: 6000 }, (_, i) => ({
			grade: `G${i.toString(36).toUpperCase()}_X`,
			display_name: 'X'.repeat(180),
			stock_status: 'in_stock',
			lead_time_default_days: 0
		}));
		const big = JSON.stringify({ materials });
		expect(big.length).toBeGreaterThan(1024 * 1024);
		const req = new Request('http://localhost/api/catalogue/materials', {
			method: 'PUT',
			headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
			body: big
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: req } as any);
		expect(res.status).toBe(413);
	});
});

describe('GET /api/catalogue/materials', () => {
	it('returns { materials: [] } on cold cache', async () => {
		const { GET } = await loadHandlers();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({} as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { materials: unknown[]; received_at?: string };
		expect(body.materials).toEqual([]);
		expect(body.received_at).toBeUndefined();
	});

	it('PUT-then-GET round-trips the snapshot with received_at', async () => {
		const { PUT, GET } = await loadHandlers();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await PUT({ request: bearerReq(goodBody(3)) } as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({} as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			materials: { grade: string }[];
			received_at?: string;
		};
		expect(body.materials).toHaveLength(3);
		expect(body.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('sets a short public Cache-Control header', async () => {
		const { GET } = await loadHandlers();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({} as any);
		expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
	});

	it('is reachable without an Authorization header', async () => {
		const { GET } = await loadHandlers();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({} as any);
		expect(res.status).toBe(200);
	});
});

// S338 — the live `/quote` fallback defect. ABERP pushes its real seed
// grades ("6061-T6", "304", "Ti-6Al-4V", "Inconel 718", …); pre-S338 the
// receiver 400'd them and the snapshot never landed, so the dropdown stayed
// on the generic Aluminum/Steel/… fallback. This proves the real grades
// round-trip through PUT → GET so the page renders the catalogue branch
// (`{#if catalogueMaterials.length > 0}`) instead of the fallback.
describe('s338: catalogue push delivers real ABERP grades to the /quote dropdown', () => {
	const REAL_SEED = [
		{ grade: '6061-T6', display_name: 'Aluminium 6061-T6' },
		{ grade: '7075-T651', display_name: 'Aluminium 7075-T651' },
		{ grade: '304', display_name: 'Stainless steel 304' },
		{ grade: '316', display_name: 'Stainless steel 316' },
		{ grade: 'Ti-6Al-4V', display_name: 'Titanium Ti-6Al-4V (Grade 5)' },
		{ grade: 'Inconel 718', display_name: 'Nickel superalloy Inconel 718' },
		{ grade: 'PEEK', display_name: 'PEEK' }
	];

	function realSeedBody(): string {
		return JSON.stringify({
			materials: REAL_SEED.map((m) => ({
				...m,
				stock_status: 'in_stock' as const,
				lead_time_default_days: 0
			}))
		});
	}

	it('s338_catalogue_push_delivers_snapshot_to_storefront_on_change', async () => {
		const { PUT } = await loadHandlers();
		// The push that pre-S338 returned 400 must now return 200 and persist.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await PUT({ request: bearerReq(realSeedBody()) } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { received_count: number };
		expect(body.received_count).toBe(REAL_SEED.length);
	});

	it('s338_storefront_renders_catalogue_dropdown_when_snapshot_present', async () => {
		const { PUT, GET } = await loadHandlers();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await PUT({ request: bearerReq(realSeedBody()) } as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await GET({} as any);
		const body = (await res.json()) as { materials: { grade: string }[] };
		// Non-empty snapshot → the page renders the catalogue branch, not the
		// hard-coded Aluminum/Steel/… fallback.
		expect(body.materials.length).toBe(REAL_SEED.length);
		expect(body.materials.map((m) => m.grade)).toContain('6061-T6');
		expect(body.materials.map((m) => m.grade)).toContain('Inconel 718');
	});
});
