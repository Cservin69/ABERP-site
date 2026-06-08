import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * PR-07 integration test for the fire-and-forget submission-received email
 * path. Covers the three failure shapes the brief calls out: happy, missing
 * relay token, and 503 from the relay. Each case asserts the same outer
 * invariant — the customer's POST always sees a 200 — and varies what happens
 * inside the setImmediate body that runs after the response is queued.
 *
 * Unlike quote-validation.spec.ts (which mocks the entire email module out),
 * this file deliberately exercises the real `sendSubmissionReceivedEmail` so
 * the relay client → fetch chain is wired through. The fetch is the only
 * boundary stubbed.
 */

const { mockEnv, TMP_QUOTE_DIR } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM imports resolve
	const fs = require('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const path = require('node:path');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const os = require('node:os');
	const root = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-pr07-quote-'));
	process.env.ABERP_SITE_QUOTE_DIR = root;
	return {
		mockEnv: {} as Record<string, string | undefined>,
		TMP_QUOTE_DIR: root as string
	};
});

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(mockEnv as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

function configure(extra: Record<string, string> = {}): void {
	Object.assign(mockEnv, {
		ABERP_INTERNAL_BASE_URL: 'https://aberp.example',
		ABERP_EMAIL_RELAY_TOKEN: 'relay-token',
		ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com',
		ABERP_SITE_PUBLIC_URL: 'https://abenerp.com',
		QUOTE_STATUS_SIGNING_KEY: 'pr07-unit-test-signing-key-0123456789ab',
		...extra
	});
}

function clearEnv(): void {
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
}

const TMP_CATALOGUE_DIR = mkdtempSync(resolve(tmpdir(), 'aberp-pr07-cat-'));
process.env.ABERP_SITE_CATALOGUE_DIR = TMP_CATALOGUE_DIR;

const fetchMock = vi.fn();
let warnMock: ReturnType<typeof vi.spyOn>;
let errorMock: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	clearEnv();
	try {
		rmSync(TMP_QUOTE_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync(TMP_QUOTE_DIR, { recursive: true });
	fetchMock.mockReset();
	fetchMock.mockImplementation(
		async () =>
			new Response(JSON.stringify({ audit_id: 'evt_ok' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
	errorMock = vi.spyOn(console, 'error').mockImplementation(() => {});
	// Reset email module's in-memory rate-limit state between tests so a prior
	// happy-path call doesn't cool down the second test's recipient.
	const email = await import('$lib/server/email');
	email.__resetRateLimit();
});

afterAll(() => {
	try {
		rmSync(TMP_QUOTE_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	try {
		rmSync(TMP_CATALOGUE_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function makeForm(): FormData {
	const form = new FormData();
	form.append('name', 'Ada Lovelace');
	form.append('email', 'ada@example.com');
	form.append('company', 'Analytical Eng');
	form.append('material', 'aluminum');
	form.append('consent', 'true');
	// A minimal valid binary STL: 80-byte header + 4-byte triangle count = 0.
	const header = Buffer.alloc(80);
	const count = Buffer.alloc(4);
	const stl = Buffer.concat([header, count]);
	form.append('files', new File([new Uint8Array(stl)], 'cube.stl'));
	return form;
}

async function importHandler() {
	const mod = await import('./+server');
	return mod.POST;
}

/** Wait for the fire-and-forget setImmediate body to flush. */
function flushImmediate(): Promise<void> {
	return new Promise((r) => setImmediate(r));
}

describe('/api/quote → submission-received relay (PR-07)', () => {
	it('happy path: 200 OK and relay-client called once with the right shape', async () => {
		configure();
		const POST = await importHandler();
		const req = new Request('https://abenerp.com/api/quote', {
			method: 'POST',
			headers: { origin: 'https://abenerp.com' },
			body: makeForm()
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string };
		expect(body.status).toBe('received');
		expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

		await flushImmediate();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0];
		const url = String(call[0]);
		const init = call[1] as RequestInit;
		expect(url).toBe('https://aberp.example/api/internal/send-email');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer relay-token');
		const relayBody = JSON.parse(String(init.body));
		expect(relayBody.to).toEqual(['ada@example.com']);
		expect(relayBody.cc).toEqual(['ops@abenerp.com']);
		expect(relayBody.subject).toMatch(/Áben Consulting — Submission received, quote #/);
		expect(relayBody.body_text).toContain('Köszönjük az ajánlatkérést');
		expect(relayBody.body_text).toContain('Thank you for your quote request');
		expect(relayBody.body_text).toContain(`/q/${body.id}?t=`);
	});

	it('relay token missing: 200 OK, no relay call, warn logged', async () => {
		// Configure operator + public URL but omit ABERP_EMAIL_RELAY_TOKEN. This
		// trips the unconfigured short-circuit in sendSubmissionReceivedEmail.
		configure({ ABERP_EMAIL_RELAY_TOKEN: '' });
		const POST = await importHandler();
		const req = new Request('https://abenerp.com/api/quote', {
			method: 'POST',
			headers: { origin: 'https://abenerp.com' },
			body: makeForm()
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(200);

		await flushImmediate();

		expect(fetchMock).not.toHaveBeenCalled();
		const warned = warnMock.mock.calls.some((c: unknown[]) =>
			String(c[0] ?? '').includes('submission-received skipped')
		);
		expect(warned).toBe(true);
	});

	it('relay returns 503: 200 OK, typed error logged, no exception bubbles', async () => {
		configure();
		fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
		const POST = await importHandler();
		const req = new Request('https://abenerp.com/api/quote', {
			method: 'POST',
			headers: { origin: 'https://abenerp.com' },
			body: makeForm()
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(200);

		await flushImmediate();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// relaySendSafe catches EmailRelayError and logs to console.error with the
		// typed kind. We don't dictate exact text — the contract is "logged, not
		// thrown" — but `unavailable` should appear since 503 maps to it.
		const errored = errorMock.mock.calls.some((c: unknown[]) =>
			String(c[0] ?? '').includes('unavailable')
		);
		expect(errored).toBe(true);
	});
});
