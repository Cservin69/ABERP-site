/**
 * S354 / ADR-0005 amendment — operator accept-on-behalf branch of
 * `POST /api/quotes/[id]/status` (`status: 'operator_accepted'`).
 *
 * Mirrors `status.spec.ts`'s harness (hoisted env mock + tmpdir quote
 * store). Covers: valid HMAC → 200 + `approved` + audit fields; valid
 * Bearer but invalid / missing HMAC → 401; already-approved → 409
 * idempotency; non-`quoted` source → 409; channel / note validation; and
 * that the customer-owned plain-Bearer `approved` path is unchanged.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';

const ADMIN_TOKEN = 'unit-test-admin-token';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-op-accept-'));

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
const OPERATOR = 'operator-ada';
const ACCEPTED_AT_MS = 1_780_000_000_000;

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

/** Sign exactly the way ABERP does — independently of the lib under test. */
function sign(
	id: string,
	channel: string,
	ms: number,
	operator: string,
	secret = ADMIN_TOKEN
): string {
	const msg = `${id}|operator_accept|${channel}|${ms}|${operator}`;
	return createHmac('sha256', secret).update(msg).digest('hex');
}

function acceptReq(
	id: string,
	body: Record<string, unknown>,
	opts?: { token?: string }
): Request {
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

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: 'operator_accepted',
		channel: 'phone',
		note: 'customer confirmed by phone',
		operator_user_id: OPERATOR,
		accepted_at_ms: ACCEPTED_AT_MS,
		hmac_signature: sign(QUOTE_ID, 'phone', ACCEPTED_AT_MS, OPERATOR),
		...overrides
	};
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
const call = (POST: any, id: string, req: Request) => POST({ params: { id }, request: req } as any);

describe('POST /api/quotes/{id}/status — operator accept-on-behalf', () => {
	it('valid Bearer + valid HMAC flips quoted → approved with operator audit fields', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted', { pricing: { total: 100 } });
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, validBody()));
		expect(res.status).toBe(200);

		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('approved');
		expect(after.accepted_via).toBe('operator');
		expect(after.operator_user_id).toBe(OPERATOR);
		expect(after.operator_channel).toBe('phone');
		expect(after.operator_note).toBe('customer confirmed by phone');
		expect(after.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		const history = after.status_history as { from: string; to: string; notes: string }[];
		expect(history).toHaveLength(1);
		expect(history[0].from).toBe('quoted');
		expect(history[0].to).toBe('approved');
		expect(history[0].notes).toContain('Operator accept on behalf via phone');
	});

	it('valid Bearer but INVALID HMAC is 401 and leaves the quote unchanged', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const res = await call(
			POST,
			QUOTE_ID,
			acceptReq(QUOTE_ID, validBody({ hmac_signature: 'f'.repeat(64) }))
		);
		expect(res.status).toBe(401);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('missing HMAC is 401 (refuses to accept without proof)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const body = validBody();
		delete body.hmac_signature;
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, body));
		expect(res.status).toBe(401);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('tampering a bound field (channel) invalidates the signature → 401', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		// signature was computed for 'phone' but the body says 'email'.
		const res = await call(
			POST,
			QUOTE_ID,
			acceptReq(QUOTE_ID, validBody({ channel: 'email' }))
		);
		expect(res.status).toBe(401);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('already-approved quote is a 409 idempotency reject', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'approved');
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, validBody()));
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('already_accepted');
	});

	it('a non-quoted source state is a 409 forbidden transition', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'received');
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, validBody()));
		expect(res.status).toBe(409);
		expect(readSeeded(QUOTE_ID).status).toBe('received');
	});

	it('an unknown channel is a 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		// HMAC over the bogus channel so we isolate the channel-vocab gate
		// from the signature gate.
		const res = await call(
			POST,
			QUOTE_ID,
			acceptReq(
				QUOTE_ID,
				validBody({
					channel: 'sms',
					hmac_signature: sign(QUOTE_ID, 'sms', ACCEPTED_AT_MS, OPERATOR)
				})
			)
		);
		expect(res.status).toBe(400);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('an empty note is a 400', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, validBody({ note: '   ' })));
		expect(res.status).toBe(400);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('missing Bearer is a 401 (requireAdminAuth gate, before any branch)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		expect(
			await statusOf(call(POST, QUOTE_ID, acceptReq(QUOTE_ID, validBody(), { token: '' })))
		).toBe(401);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('the customer-owned plain-Bearer `approved` path is still forbidden (unchanged)', async () => {
		const { POST } = await loadHandler();
		seedQuote(QUOTE_ID, 'quoted');
		const res = await call(POST, QUOTE_ID, acceptReq(QUOTE_ID, { status: 'approved' }));
		expect(res.status).toBe(403);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});
});
