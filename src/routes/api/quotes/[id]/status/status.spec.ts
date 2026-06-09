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

describe('POST /api/quotes/{id}/status — PR-10 / S297 F3: idempotent same-state on every status', () => {
	// S296 F3 — the S295 forbidden-target gate pre-empted `from === to`
	// for `quoted` and `approved`. An ABERP idempotent re-poll against
	// an already-approved row received a hard 403 instead of a 200 noop.
	// The fix moves `from === to` ABOVE the forbidden gates so idempotent
	// same-state is universally safe. These pins prevent regression to
	// the F3 shape — they are load-bearing for ABERP's intake daemon
	// retry semantics.

	it('idempotent_same_state_approved_returns_noop_200', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved', {
			status_history: [
				{ at: 'x', from: 'received', to: 'quoting', notes: '' },
				{ at: 'y', from: 'quoting', to: 'quoted', notes: '' },
				{ at: 'z', from: 'quoted', to: 'approved', notes: '' }
			]
		});
		const req = postReq(QUOTE_ID, { status: 'approved' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		// MUST be 200 noop, NOT 403 forbidden_transition. Pre-PR-10 this
		// returned 403 because the forbidden-target gate ran first.
		expect(res.status).toBe(200);
		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('approved');
		// No additional status_history row — noop must be silent.
		expect((after.status_history as unknown[]).length).toBe(3);
	});

	it('idempotent_same_state_quoted_returns_noop_200', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted', {
			status_history: [{ at: 'x', from: 'received', to: 'quoting', notes: '' }]
		});
		const req = postReq(QUOTE_ID, { status: 'quoted' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		// MUST be 200 noop, NOT 403. The /priced endpoint is the legitimate
		// first-time writer for `quoted` — but an idempotent re-write from
		// a row already at `quoted` is universally safe.
		expect(res.status).toBe(200);
		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('quoted');
		expect((after.status_history as unknown[]).length).toBe(1);
	});

	it('idempotent_same_state_invoiced_returns_noop_200', async () => {
		// Terminal-state idempotency — was already 200 noop pre-PR-10
		// because `to === 'invoiced'` was not in the forbidden-target
		// set. Pin it so a future refactor doesn't add `invoiced` to
		// that list and silently re-open the same-shape gap.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'invoiced');
		const req = postReq(QUOTE_ID, { status: 'invoiced' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(200);
		expect(readSeeded(QUOTE_ID).status).toBe('invoiced');
	});

	it('first-time set of `approved` from a non-quoted state is STILL forbidden (403)', async () => {
		// Defence-in-depth: the F3 fix relaxes the noop case ONLY. The
		// typed-ACCEPT gate (S295 F3 design intent) must still hold —
		// a bearer-authed caller cannot newly set `approved` from any
		// non-approved state. Pre-PR-10 this returned 403; post-PR-10
		// it must STILL return 403.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const req = postReq(QUOTE_ID, { status: 'approved' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('approved is only settable by the customer accept POST');
	});

	it('first-time set of `quoted` from a non-quoted state is STILL forbidden (403)', async () => {
		// Same defence-in-depth as above for the /priced ownership of
		// the `quoted` transition.
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const req = postReq(QUOTE_ID, { status: 'quoted' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await POST({ params: { id: QUOTE_ID }, request: req } as any);
		expect(res.status).toBe(403);
	});
});
