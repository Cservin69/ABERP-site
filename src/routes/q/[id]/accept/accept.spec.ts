import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SIGNING_KEY = 'unit-test-signing-key-0123456789abcdef';
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-accept-'));

// quote-store reads ABERP_SITE_QUOTE_DIR at module load via process.env —
// must be set before any import drags quote-store in. (S277 / PR-02 trap.)
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
	// Wipe relay envs so sendAcceptedConfirmationEmail returns `skipped`
	// without trying to fetch anything from a test runner.
	delete envState.ABERP_INTERNAL_BASE_URL;
	delete envState.ABERP_EMAIL_RELAY_TOKEN;
	delete envState.ABERP_SITE_OPERATOR_EMAIL;
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

function pricingFor(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		received_at: '2026-06-08T10:00:00Z',
		valid_until: '2099-12-31',
		breakdown_json: { total_eur: 123.45 },
		pdf_stored_at: 'priced.pdf',
		feature_graph_hash: 'blake3:abc',
		extractor_version: 'v1',
		engine_version: 'v1',
		stock_alert: false,
		...over
	};
}

function readSeeded(id: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(TMP_ROOT, id, 'metadata.json'), 'utf8'));
}

async function loadModule() {
	return await import('./+page.server');
}

async function statusOf(p: unknown): Promise<number> {
	try {
		await p;
		return 200;
	} catch (err) {
		return (err as { status: number }).status;
	}
}

function url(id: string, ts: string, sig: string): URL {
	const u = new URL(`http://localhost/q/${id}/accept`);
	u.searchParams.set('ts', ts);
	u.searchParams.set('sig', sig);
	return u;
}

async function freshSig(id: string): Promise<{ ts: string; sig: string }> {
	const { signAcceptToken, defaultAcceptExpiryIso } = await import('$lib/server/quote-token');
	const ts = defaultAcceptExpiryIso(Date.now());
	const sig = signAcceptToken(id, ts);
	return { ts, sig };
}

describe('GET /q/{id}/accept — signature + expiry verification', () => {
	it('throws 404 on a malformed quote id', async () => {
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const event = {
			params: { id: 'not-a-uuid' },
			url: url('not-a-uuid', ts, sig)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(404);
	});

	it('throws 404 when ts or sig is missing', async () => {
		const { load } = await loadModule();
		const u = new URL(`http://localhost/q/${QUOTE_ID}/accept`);
		const event = {
			params: { id: QUOTE_ID },
			url: u
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(404);
	});

	it('throws 403 on a tampered signature (HMAC fails before expiry is checked)', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, tampered)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(403);
	});

	it('throws 403 on a past-expiry ts even when the signature matches', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { signAcceptToken } = await import('$lib/server/quote-token');
		const past = '2000-01-01T00:00:00.000Z';
		const sig = signAcceptToken(QUOTE_ID, past);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, past, sig)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(403);
	});

	it('returns view=confirm for a valid signed link on a quoted quote', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor({ valid_until: '2099-12-31' }) });
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig),
			setHeaders: () => {}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		const data = await load(event);
		expect((data as { view: string }).view).toBe('confirm');
		expect((data as { acceptToken: string }).acceptToken).toBe('ACCEPT');
		expect(
			(data as { quote: { pricing: { valid_until: string } } }).quote.pricing.valid_until
		).toBe('2099-12-31');
	});

	it('returns view=already-approved when the quote is already in approved state', async () => {
		seedQuote(QUOTE_ID, 'approved', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig),
			setHeaders: () => {}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		const data = await load(event);
		expect((data as { view: string }).view).toBe('already-approved');
	});

	it('throws 409 when the quote is not yet in quoted state', async () => {
		seedQuote(QUOTE_ID, 'received');
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig),
			setHeaders: () => {}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(409);
	});

	it('throws 404 on a signed link whose quote does not exist', async () => {
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(404);
	});

	it('sets cache-control: private, no-store on every load (S285 F10 — PII prefetch defense)', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const headers: Record<string, string> = {};
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig),
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		await load(event);
		// `private` keeps shared caches out; `no-store` keeps disk caches out; both
		// frustrate MTA-side prefetchers (Outlook Safe Links, Gmail Mailer-Daemon,
		// corporate egress proxies) that would otherwise speculatively GET the link
		// and end up holding customer name/email in some intermediate cache.
		expect(headers['cache-control']).toBe('private, no-store, max-age=0');
		expect(headers['pragma']).toBe('no-cache');
	});

	it('sets prefetch-defense headers even on the already-approved branch (S285 F10)', async () => {
		seedQuote(QUOTE_ID, 'approved', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const headers: Record<string, string> = {};
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, sig),
			setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		await load(event);
		// already-approved still renders customer name + email in the thank-you
		// copy, so the same headers must apply.
		expect(headers['cache-control']).toContain('no-store');
	});

	it('rejects a status-link signature presented as an accept signature (domain separation)', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { load } = await loadModule();
		const { signQuoteToken, defaultAcceptExpiryIso } = await import('$lib/server/quote-token');
		const statusSig = signQuoteToken(QUOTE_ID);
		const ts = defaultAcceptExpiryIso(Date.now());
		const event = {
			params: { id: QUOTE_ID },
			url: url(QUOTE_ID, ts, statusSig)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		} as any;
		expect(await statusOf(load(event))).toBe(403);
	});
});

describe('POST /q/{id}/accept — accept action', () => {
	function actionEvent(
		id: string,
		ts: string,
		sig: string,
		fields: Record<string, string>
	): unknown {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		return {
			params: { id },
			url: url(id, ts, sig),
			request: new Request(`http://localhost/q/${id}/accept`, {
				method: 'POST',
				body: form
			})
		};
	}

	it('flips quoted → approved, persists audit fields, appends status_history', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await (actions.default as (e: any) => Promise<any>)(ev);
		expect((res as { accepted: boolean }).accepted).toBe(true);
		expect((res as { alreadyApproved: boolean }).alreadyApproved).toBe(false);

		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('approved');
		expect(after.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(after.acceptance_signature_ts).toBe(ts);
		const history = after.status_history as { from: string; to: string; notes: string }[];
		expect(history).toHaveLength(1);
		expect(history[0].from).toBe('quoted');
		expect(history[0].to).toBe('approved');
		expect(history[0].notes).toContain(`/q/${QUOTE_ID}/accept`);
	});

	it('fails with 400 when the typed token does not match exactly (case-sensitive)', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'accept' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await (actions.default as (e: any) => Promise<any>)(ev);
		// SvelteKit's fail() returns { status: 400, data: {...} }.
		expect((res as { status: number }).status).toBe(400);
		// State is unchanged.
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('fails with 400 when the typed token is empty', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev = actionEvent(QUOTE_ID, ts, sig, { accept_token: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await (actions.default as (e: any) => Promise<any>)(ev);
		expect((res as { status: number }).status).toBe(400);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('throws 403 on a captured ts/sig that has since expired', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { signAcceptToken } = await import('$lib/server/quote-token');
		const past = '2000-01-01T00:00:00.000Z';
		const sig = signAcceptToken(QUOTE_ID, past);
		const ev = actionEvent(QUOTE_ID, past, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf((actions.default as (e: any) => Promise<any>)(ev))).toBe(403);
		expect(readSeeded(QUOTE_ID).status).toBe('quoted');
	});

	it('throws 403 on a tampered signature', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
		const ev = actionEvent(QUOTE_ID, ts, tampered, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf((actions.default as (e: any) => Promise<any>)(ev))).toBe(403);
	});

	it('replayed accept on an already-approved quote returns alreadyApproved without re-writing', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev1 = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await (actions.default as (e: any) => Promise<any>)(ev1);
		const after1 = readSeeded(QUOTE_ID);
		const accepted_at_1 = after1.accepted_at;
		const history1 = (after1.status_history as unknown[]).length;

		const ev2 = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		const res = await (actions.default as (e: any) => Promise<any>)(ev2);
		expect((res as { accepted: boolean }).accepted).toBe(true);
		expect((res as { alreadyApproved: boolean }).alreadyApproved).toBe(true);

		const after2 = readSeeded(QUOTE_ID);
		expect(after2.accepted_at).toBe(accepted_at_1);
		expect((after2.status_history as unknown[]).length).toBe(history1);
	});

	it('throws 409 if the quote is not in quoted state at POST time', async () => {
		seedQuote(QUOTE_ID, 'received');
		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		expect(await statusOf((actions.default as (e: any) => Promise<any>)(ev))).toBe(409);
	});

	it('enqueues the accept-confirmation email when the operator inbox is configured, but does NOT set acceptance_audit_id (ADR-0009)', async () => {
		seedQuote(QUOTE_ID, 'quoted', { pricing: pricingFor() });
		// Under ADR-0009 the only env still load-bearing for the email path is
		// the operator inbox. The accept-handler enqueues to disk and ABERP
		// fills the audit id later, via POST /api/internal/email-queue/{id}/sent —
		// the storefront cannot capture it synchronously any more.
		envState.ABERP_SITE_OPERATOR_EMAIL = 'ops@abenerp.com';

		const { actions } = await loadModule();
		const { ts, sig } = await freshSig(QUOTE_ID);
		const ev = actionEvent(QUOTE_ID, ts, sig, { accept_token: 'ACCEPT' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal stub
		await (actions.default as (e: any) => Promise<any>)(ev);

		const after = readSeeded(QUOTE_ID);
		expect(after.status).toBe('approved');
		// Field is intentionally unset on the accept write — see ADR-0009.
		expect(after.acceptance_audit_id).toBeUndefined();
		// acceptance_signature_ts remains the binding proof.
		expect(after.acceptance_signature_ts).toBe(ts);
	});
});
