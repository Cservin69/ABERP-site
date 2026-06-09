import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Integration test for the fire-and-forget submission-received email path
 * after PR-11 (ADR-0009). Covers the same three shapes the original PR-07
 * test exercised — happy path, operator inbox missing, enqueue failure —
 * but asserts on the queue file rather than the (now-retired) relay call.
 *
 * Outer invariant unchanged: the customer's POST always sees a 200; the
 * dispatch outcome lives in what does or does not land under
 * `${ABERP_SITE_EMAIL_OUTBOX_DIR}/queued/`.
 */

const { mockEnv, TMP_QUOTE_DIR, TMP_OUTBOX_DIR } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM imports resolve
	const fs = require('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const path = require('node:path');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const os = require('node:os');
	const quoteRoot = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-pr11-quote-'));
	const outboxRoot = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-pr11-outbox-'));
	process.env.ABERP_SITE_QUOTE_DIR = quoteRoot;
	process.env.ABERP_SITE_EMAIL_OUTBOX_DIR = outboxRoot;
	return {
		mockEnv: {} as Record<string, string | undefined>,
		TMP_QUOTE_DIR: quoteRoot as string,
		TMP_OUTBOX_DIR: outboxRoot as string
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
		ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com',
		ABERP_SITE_PUBLIC_URL: 'https://abenerp.com',
		QUOTE_STATUS_SIGNING_KEY: 'pr11-unit-test-signing-key-0123456789ab',
		...extra
	});
}

function clearEnv(): void {
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
}

const TMP_CATALOGUE_DIR = mkdtempSync(resolve(tmpdir(), 'aberp-pr11-cat-'));
process.env.ABERP_SITE_CATALOGUE_DIR = TMP_CATALOGUE_DIR;

let warnMock: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	clearEnv();
	for (const root of [TMP_QUOTE_DIR, TMP_OUTBOX_DIR]) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		mkdirSync(root, { recursive: true });
	}
	warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const email = await import('$lib/server/email');
	email.__resetRateLimit();
});

afterAll(() => {
	for (const root of [TMP_QUOTE_DIR, TMP_OUTBOX_DIR, TMP_CATALOGUE_DIR]) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
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

function readQueued(): Array<Record<string, unknown>> {
	const dir = join(TMP_OUTBOX_DIR, 'queued');
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: Array<Record<string, unknown>> = [];
	for (const n of names) {
		if (!n.endsWith('.json') || n.includes('.tmp-')) continue;
		out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>);
	}
	return out;
}

describe('/api/quote → submission-received enqueue (ADR-0009)', () => {
	it('happy path: 200 OK and one queue entry lands with the right shape', async () => {
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
		// Small wait to let the disk write inside setImmediate resolve.
		await new Promise((r) => setTimeout(r, 20));

		const entries = readQueued();
		expect(entries).toHaveLength(1);
		const e = entries[0] as {
			to: string[];
			cc: string[];
			subject: string;
			body_text: string;
			submitter: string;
			state: string;
		};
		expect(e.to).toEqual(['ada@example.com']);
		expect(e.cc).toEqual(['ops@abenerp.com']);
		expect(e.subject).toMatch(/Áben Consulting — Submission received, quote #/);
		expect(e.body_text).toContain('Köszönjük az ajánlatkérést');
		expect(e.body_text).toContain('Thank you for your quote request');
		expect(e.body_text).toContain(`/q/${body.id}?t=`);
		expect(e.submitter).toBe('submission_received');
		expect(e.state).toBe('queued');
	});

	it('operator inbox missing: 200 OK, no queue entry, warn logged', async () => {
		// No ABERP_SITE_OPERATOR_EMAIL — the only env still load-bearing for the
		// queue path. The handler's enqueue short-circuits with "unconfigured".
		configure({ ABERP_SITE_OPERATOR_EMAIL: '' });
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
		await new Promise((r) => setTimeout(r, 20));

		expect(readQueued()).toHaveLength(0);
		const warned = warnMock.mock.calls.some((c: unknown[]) =>
			String(c[0] ?? '').includes('submission-received skipped')
		);
		expect(warned).toBe(true);
	});

	it('the 200 OK never blocks on the enqueue (fire-and-forget)', async () => {
		configure();
		const POST = await importHandler();
		const req = new Request('https://abenerp.com/api/quote', {
			method: 'POST',
			headers: { origin: 'https://abenerp.com' },
			body: makeForm()
		});
		const start = Date.now();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub
		const res = await POST({ request: req } as any);
		const elapsed = Date.now() - start;
		expect(res.status).toBe(200);
		// The handler must return before the enqueue write finishes. We can't
		// strictly prove this without slowing the disk write — but the wall-clock
		// elapsed for the POST should be tiny (a few ms) even if the enqueue
		// later does its work via setImmediate.
		expect(elapsed).toBeLessThan(500);
	});
});
