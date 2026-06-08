import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ADMIN_TOKEN = 'unit-test-admin-token';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-status-'));

// quote-store reads ABERP_SITE_QUOTE_DIR at module load. Must be set before
// any static import drags quote-store in (S277 / PR-02 trap).
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

const QUOTE_ID = '11111111-2222-3333-4444-555555555555';

function seedQuote(id: string, status: string, extra: Record<string, unknown> = {}): void {
	const dir = join(TMP_ROOT, id);
	mkdirSync(dir, { recursive: true });
	const metadata = {
		id,
		received_at: '2026-06-06T10:00:00Z',
		contact: { name: 'Test', email: 'test@example.com', company: '' },
		request: { material_preference: 'AL_6061_T6', quantity: 5, deadline: null, notes: '' },
		files: [],
		status,
		consent_at: '2026-06-06T10:00:00Z',
		...extra
	};
	writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
}

function readSeeded(id: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(TMP_ROOT, id, 'metadata.json'), 'utf8'));
}

function postReq(id: string, body: unknown, opts?: { token?: string }): Request {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts?.token !== '') {
		headers['authorization'] = `Bearer ${opts?.token ?? ADMIN_TOKEN}`;
	}
	return new Request(`http://localhost/api/quotes/${id}/status`, {
		method: 'POST',
		headers,
		body: JSON.stringify(body)
	});
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

describe('POST /api/quotes/{id}/status — auth + input validation', () => {
	it('rejects missing Authorization with 401', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'quoting' }, { token: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(401);
	});

	it('rejects wrong bearer with 401', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'quoting' }, { token: 'nope' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(401);
	});

	it('rejects an unknown status value with 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'fingerlickin' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(400);
	});

	it('rejects a 404 when the quote does not exist', async () => {
		const { POST } = await loadHandler();
		const req = postReq(QUOTE_ID, { status: 'quoting' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf(POST({ params: { id: QUOTE_ID }, request: req } as any))).toBe(404);
	});
});

describe('POST /api/quotes/{id}/status — F3 state machine: forbidden writes to quoted/approved', () => {
	it('refuses to set status=quoted (priced-writeback owns this) with 403', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'quoted' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('quoted is only settable');
		// State must be unchanged.
		expect(readSeeded(QUOTE_ID).status).toBe('received');
	});

	it('refuses to set status=approved from quoted (typed-ACCEPT owns this) with 403', async () => {
		// The most adversarial case — a compromised ABERP bearer trying to skip
		// the typed-ACCEPT theater by writing approved directly. ADR-0005's
		// whole point is that approved is unreachable from the Bearer path.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const req = postReq(QUOTE_ID, { status: 'approved' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('approved is only settable by the customer accept POST');
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('refuses to set status=approved from received with 403 (cannot skip the whole arc)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'approved' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(403);
		expect(readSeeded(QUOTE_ID).status).toBe('received');
	});
});

describe('POST /api/quotes/{id}/status — F3 state machine: quoting transitions', () => {
	it('allows received → quoting and appends status_history', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'quoting', notes: 'pulled by ABERP' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('quoting');
		const history = after.status_history as { from: string; to: string; notes: string }[];
		expect(history).toHaveLength(1);
		expect(history[0].from).toBe('received');
		expect(history[0].to).toBe('quoting');
		expect(history[0].notes).toBe('pulled by ABERP');
	});

	it('allows quoting → quoting as a no-op idempotent re-pull (no extra history row)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoting', {
			status_history: [{ at: 'x', from: 'received', to: 'quoting', notes: '' }]
		});
		const req = postReq(QUOTE_ID, { status: 'quoting' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('quoting');
		expect((after.status_history as unknown[]).length).toBe(1);
	});

	it('refuses quoted → quoting with 409 (cannot regress from priced state)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const req = postReq(QUOTE_ID, { status: 'quoting' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});
});

describe('POST /api/quotes/{id}/status — F3 state machine: rejected + invoiced', () => {
	it('allows received → rejected (operator decline)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'rejected', notes: 'spam' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		expect(readSeeded(QUOTE_ID).status).toBe('rejected');
	});

	it('allows quoting → rejected and quoted → rejected (operator can decline at any non-terminal stage)', async () => {
		const { POST } = await loadHandler();
		for (const from of ['quoting', 'quoted'] as const) {
			seedQuote(QUOTE_ID, from);
			const req = postReq(QUOTE_ID, { status: 'rejected' });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
			const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
			expect(res.status).toBe(200);
			expect(readSeeded(QUOTE_ID).status).toBe('rejected');
		}
	});

	it('refuses approved → rejected with 409 (terminal states are absorbing)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved');
		const req = postReq(QUOTE_ID, { status: 'rejected' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
		expect(readSeeded(QUOTE_ID).status).toBe('approved');
	});

	it('refuses invoiced → rejected with 409 (terminal states are absorbing)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'invoiced');
		const req = postReq(QUOTE_ID, { status: 'rejected' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});

	it('allows approved → invoiced (ABERP DEAL completion)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved');
		const req = postReq(QUOTE_ID, { status: 'invoiced', notes: 'DEAL-12345 closed' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		expect(readSeeded(QUOTE_ID).status).toBe('invoiced');
	});

	it('refuses received → invoiced with 409 (cannot skip approval)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'invoiced' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});

	it('refuses quoted → invoiced with 409 (cannot skip customer accept)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const req = postReq(QUOTE_ID, { status: 'invoiced' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});
});

describe('POST /api/quotes/{id}/status — received is initial-only', () => {
	it('refuses quoting → received with 409 (received is the initial state only)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoting');
		const req = postReq(QUOTE_ID, { status: 'received' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(409);
	});

	it('allows received → received as a no-op (idempotent)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'received' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('received');
		// No status_history written for a same-state no-op.
		expect(after.status_history).toBeUndefined();
	});
});
