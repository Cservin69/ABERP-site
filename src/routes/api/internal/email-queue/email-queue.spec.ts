import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Endpoint tests for the four `/api/internal/email-queue/*` routes (ADR-0009).
 *
 * Auth gating is delegated to `requireAdminAuth` (already exercised by
 * `auth.spec.ts` and `catalogue.spec.ts`); we test it once per route so a
 * future refactor that drops the call site is caught here, and otherwise
 * focus on the queue-state transitions and idempotency contracts.
 */

const TOKEN = 'unit-test-admin-token';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-email-queue-endpoint-'));

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

process.env.ABERP_SITE_EMAIL_OUTBOX_DIR = TMP_ROOT;

type OutboxModule = typeof import('$lib/server/email-outbox');

async function loadOutbox(): Promise<OutboxModule> {
	return await import('$lib/server/email-outbox');
}

async function loadListHandler() {
	const mod = await import('./+server');
	return { GET: mod.GET };
}

async function loadClaimHandler() {
	const mod = await import('./[id]/claim/+server');
	return { POST: mod.POST };
}

async function loadSentHandler() {
	const mod = await import('./[id]/sent/+server');
	return { POST: mod.POST };
}

async function loadFailedHandler() {
	const mod = await import('./[id]/failed/+server');
	return { POST: mod.POST };
}

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

function bearerHeaders(opts?: { token?: string; contentType?: string }): Record<string, string> {
	const h: Record<string, string> = {};
	if (opts?.token !== '') {
		h['authorization'] = `Bearer ${opts?.token ?? TOKEN}`;
	}
	if (opts?.contentType !== undefined) {
		h['content-type'] = opts.contentType;
	} else {
		h['content-type'] = 'application/json';
	}
	return h;
}

async function statusOf(p: Promise<Response>): Promise<number> {
	try {
		const r = await p;
		return r.status;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

/**
 * Invoke a SvelteKit RequestHandler with a minimally-typed event stub. Going
 * through `unknown` instead of `any` keeps eslint quiet while still avoiding
 * the noise of constructing a full `RequestEvent` (most fields the handler
 * doesn't touch).
 */
type GetHandler = (event: { request: Request; url: URL }) => Promise<Response>;
type PostHandler = (event: { request: Request; params: { id: string } }) => Promise<Response>;

function callGet(handler: unknown, request: Request, url: URL): Promise<Response> {
	return (handler as GetHandler)({ request, url });
}

function callPost(handler: unknown, request: Request, params: { id: string }): Promise<Response> {
	return (handler as PostHandler)({ request, params });
}

function basePayload() {
	return {
		to: ['ada@example.com'],
		cc: ['ops@abenerp.com'],
		subject: 'hello',
		body_text: 'hi',
		body_html: '<p>hi</p>'
	};
}

describe('GET /api/internal/email-queue', () => {
	it('401 without bearer', async () => {
		const { GET } = await loadListHandler();
		const req = new Request('http://localhost/api/internal/email-queue', {
			headers: bearerHeaders({ token: '' })
		});
		expect(await statusOf(callGet(GET, req, new URL(req.url)))).toBe(401);
	});

	it('401 with wrong bearer', async () => {
		const { GET } = await loadListHandler();
		const req = new Request('http://localhost/api/internal/email-queue', {
			headers: bearerHeaders({ token: 'wrong' })
		});
		expect(await statusOf(callGet(GET, req, new URL(req.url)))).toBe(401);
	});

	it('503 when ABERP_SITE_ADMIN_TOKEN is unset', async () => {
		delete envState.ABERP_SITE_ADMIN_TOKEN;
		const { GET } = await loadListHandler();
		const req = new Request('http://localhost/api/internal/email-queue', {
			headers: bearerHeaders()
		});
		expect(await statusOf(callGet(GET, req, new URL(req.url)))).toBe(503);
	});

	it('returns queued entries in order', async () => {
		const { enqueueEmail } = await loadOutbox();
		const r1 = await enqueueEmail(basePayload(), 'submission_received');
		await new Promise((r) => setTimeout(r, 5));
		const r2 = await enqueueEmail(basePayload(), 'priced_ready');
		const { GET } = await loadListHandler();
		const req = new Request('http://localhost/api/internal/email-queue', {
			headers: bearerHeaders()
		});
		const res = await callGet(GET, req, new URL(req.url));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ id: string }> };
		expect(body.entries.map((e) => e.id)).toEqual([r1.id, r2.id]);
	});

	it('400 on a malformed since= parameter', async () => {
		const { GET } = await loadListHandler();
		const url = new URL('http://localhost/api/internal/email-queue?since=not-a-date');
		const req = new Request(url, { headers: bearerHeaders() });
		expect(await statusOf(callGet(GET, req, url))).toBe(400);
	});

	it('400 on a malformed after= cursor', async () => {
		const { GET } = await loadListHandler();
		const url = new URL('http://localhost/api/internal/email-queue?after=not-a-ulid');
		const req = new Request(url, { headers: bearerHeaders() });
		expect(await statusOf(callGet(GET, req, url))).toBe(400);
	});
});

describe('POST /api/internal/email-queue/{id}/claim', () => {
	it('401 without bearer', async () => {
		const { POST } = await loadClaimHandler();
		const { generateUlid } = await loadOutbox();
		const id = generateUlid();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/claim`, {
			method: 'POST',
			headers: bearerHeaders({ token: '' })
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(401);
	});

	it('400 on a malformed id', async () => {
		const { POST } = await loadClaimHandler();
		const req = new Request('http://localhost/api/internal/email-queue/xxx/claim', {
			method: 'POST',
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id: 'xxx' }))).toBe(400);
	});

	it('404 on an unknown id', async () => {
		const { POST } = await loadClaimHandler();
		const { generateUlid } = await loadOutbox();
		const id = generateUlid();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/claim`, {
			method: 'POST',
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(404);
	});

	it('200 on a successful claim and 409 on the second claim of the same id (race)', async () => {
		const { enqueueEmail } = await loadOutbox();
		const { POST } = await loadClaimHandler();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const mkReq = (): Request =>
			new Request(`http://localhost/api/internal/email-queue/${id}/claim`, {
				method: 'POST',
				headers: bearerHeaders()
			});
		const first = await callPost(POST, mkReq(), { id });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { state: string; attempt_n: number };
		expect(firstBody.state).toBe('claimed');
		expect(firstBody.attempt_n).toBe(1);

		// Second call — entry is now in claimed/, not queued/. Must 409.
		const second = await callPost(POST, mkReq(), { id });
		expect(second.status).toBe(409);
		const secondBody = (await second.json()) as { state: string };
		expect(secondBody.state).toBe('claimed');
	});
});

describe('POST /api/internal/email-queue/{id}/sent', () => {
	it('401 without bearer', async () => {
		const { POST } = await loadSentHandler();
		const { generateUlid } = await loadOutbox();
		const id = generateUlid();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
			method: 'POST',
			body: JSON.stringify({ audit_id: 'evt' }),
			headers: bearerHeaders({ token: '' })
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(401);
	});

	it('400 on a malformed id', async () => {
		const { POST } = await loadSentHandler();
		const req = new Request('http://localhost/api/internal/email-queue/xxx/sent', {
			method: 'POST',
			body: JSON.stringify({ audit_id: 'evt' }),
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id: 'xxx' }))).toBe(400);
	});

	it('400 on missing audit_id', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadSentHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
			method: 'POST',
			body: JSON.stringify({}),
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(400);
	});

	it('400 on audit_id with header-injection characters', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadSentHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
			method: 'POST',
			body: JSON.stringify({ audit_id: 'bad\r\nvalue' }),
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(400);
	});

	it('200 on a successful claimed→sent transition', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadSentHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
			method: 'POST',
			body: JSON.stringify({ audit_id: 'evt_ok' }),
			headers: bearerHeaders()
		});
		const res = await callPost(POST, req, { id });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { state: string; audit_id: string };
		expect(body.state).toBe('sent');
		expect(body.audit_id).toBe('evt_ok');
	});

	it('200 idempotent replay returns the same entry without overwriting audit_id', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadSentHandler();
		const mkReq = (audit: string): Request =>
			new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
				method: 'POST',
				body: JSON.stringify({ audit_id: audit }),
				headers: bearerHeaders()
			});
		const first = await callPost(POST, mkReq('evt_1'), { id });
		expect(first.status).toBe(200);
		const second = await callPost(POST, mkReq('evt_2'), { id });
		expect(second.status).toBe(200);
		const body = (await second.json()) as { audit_id: string };
		// First writer wins — replay does not overwrite the audit lineage.
		expect(body.audit_id).toBe('evt_1');
	});

	it('409 when the entry is still queued (not claimed)', async () => {
		const { enqueueEmail } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const { POST } = await loadSentHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/sent`, {
			method: 'POST',
			body: JSON.stringify({ audit_id: 'evt' }),
			headers: bearerHeaders()
		});
		const res = await callPost(POST, req, { id });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string; state: string };
		expect(body.error).toBe('not_claimed');
		expect(body.state).toBe('queued');
	});
});

describe('POST /api/internal/email-queue/{id}/failed', () => {
	it('401 without bearer', async () => {
		const { POST } = await loadFailedHandler();
		const { generateUlid } = await loadOutbox();
		const id = generateUlid();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/failed`, {
			method: 'POST',
			body: JSON.stringify({ error_class: 'x', error_detail: 'y' }),
			headers: bearerHeaders({ token: '' })
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(401);
	});

	it('400 on missing error_class', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadFailedHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/failed`, {
			method: 'POST',
			body: JSON.stringify({ error_detail: 'no class' }),
			headers: bearerHeaders()
		});
		expect(await statusOf(callPost(POST, req, { id }))).toBe(400);
	});

	it('200 on a successful claimed→failed transition', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadFailedHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/failed`, {
			method: 'POST',
			body: JSON.stringify({ error_class: 'smtp_5xx', error_detail: 'relay refused' }),
			headers: bearerHeaders()
		});
		const res = await callPost(POST, req, { id });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			state: string;
			last_error: { class: string; detail: string };
		};
		expect(body.state).toBe('failed');
		expect(body.last_error).toEqual({ class: 'smtp_5xx', detail: 'relay refused' });
	});

	it('200 idempotent replay does not overwrite last_error', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const { POST } = await loadFailedHandler();
		const mkReq = (cls: string): Request =>
			new Request(`http://localhost/api/internal/email-queue/${id}/failed`, {
				method: 'POST',
				body: JSON.stringify({ error_class: cls, error_detail: 'd' }),
				headers: bearerHeaders()
			});
		const first = await callPost(POST, mkReq('first'), { id });
		expect(first.status).toBe(200);
		const second = await callPost(POST, mkReq('second'), { id });
		expect(second.status).toBe(200);
		const body = (await second.json()) as { last_error: { class: string } };
		expect(body.last_error.class).toBe('first');
	});

	it('409 when the entry is still queued', async () => {
		const { enqueueEmail } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const { POST } = await loadFailedHandler();
		const req = new Request(`http://localhost/api/internal/email-queue/${id}/failed`, {
			method: 'POST',
			body: JSON.stringify({ error_class: 'x', error_detail: 'y' }),
			headers: bearerHeaders()
		});
		const res = await callPost(POST, req, { id });
		expect(res.status).toBe(409);
	});
});
