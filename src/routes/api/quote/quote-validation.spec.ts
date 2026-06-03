import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// The handler imports `$lib/server/email`, which in turn imports
// `$env/dynamic/private` and `nodemailer`. We stub the whole email module so
// neither tree gets touched — `sendQuoteNotifications` is contractually
// non-throwing, so a no-op is a faithful stand-in.
vi.mock('$lib/server/email', () => ({
	sendQuoteNotifications: vi.fn(async () => ({ operator: 'skipped', customer: 'skipped' }))
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', '..', 'tests', 'fixtures', 'cad');
const read = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));

let TMP_QUOTE_DIR = '';

beforeAll(() => {
	TMP_QUOTE_DIR = mkdtempSync(resolve(tmpdir(), 'aberp-pr-p-quote-'));
	process.env.ABERP_SITE_QUOTE_DIR = TMP_QUOTE_DIR;
});

afterEach(() => {
	// Best-effort: clear out any quote subdirectories between tests so each
	// run starts from a clean slate. We keep the parent tmp dir.
	try {
		rmSync(TMP_QUOTE_DIR, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function fileFromBuffer(buf: Buffer, name: string): File {
	// Node 24's global `File` accepts a BlobPart array — Buffer satisfies it
	// via Uint8Array.
	return new File([new Uint8Array(buf)], name);
}

function baseForm(): FormData {
	const form = new FormData();
	form.append('name', 'Test User');
	form.append('email', 'test@example.com');
	form.append('company', 'PR-P Test Co');
	form.append('material', 'aluminum');
	form.append('consent', 'true');
	return form;
}

async function importHandler() {
	// Re-import inside the test so the email-mock above is in place.
	const mod = await import('./+server');
	return mod.POST;
}

describe('/api/quote content-sniffing integration', () => {
	it('returns 400 with structured invalid_file payload when a PDF is uploaded as .step', async () => {
		const POST = await importHandler();
		const form = baseForm();
		form.append('files', fileFromBuffer(read('valid.step'), 'good.step'));
		form.append('files', fileFromBuffer(read('valid_ascii.stl'), 'cube.stl'));
		form.append('files', fileFromBuffer(read('not-cad.pdf'), 'taxi.step'));

		const req = new Request('http://localhost/api/quote', { method: 'POST', body: form });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub for this handler
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: string;
			files: { filename: string; reason: string }[];
		};
		expect(body.error).toBe('invalid_file');
		expect(body.files).toHaveLength(1);
		expect(body.files[0].filename).toBe('taxi.step');
		expect(body.files[0].reason).toMatch(/PDF/);
	});

	it('returns 200 + a quote id when all files validate', async () => {
		const POST = await importHandler();
		const form = baseForm();
		form.append('files', fileFromBuffer(read('valid.step'), 'part.step'));
		form.append('files', fileFromBuffer(read('valid_ascii.stl'), 'cube.stl'));
		form.append('files', fileFromBuffer(read('valid.dxf'), 'plate.dxf'));

		const req = new Request('http://localhost/api/quote', { method: 'POST', body: form });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub for this handler
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string };
		expect(body.status).toBe('received');
		expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('rejects a 0-byte file via the structured invalid_file response', async () => {
		const POST = await importHandler();
		const form = baseForm();
		form.append('files', fileFromBuffer(Buffer.alloc(0), 'empty.step'));

		const req = new Request('http://localhost/api/quote', { method: 'POST', body: form });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub for this handler
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: string;
			files: { filename: string; reason: string }[];
		};
		expect(body.error).toBe('invalid_file');
		expect(body.files).toHaveLength(1);
		expect(body.files[0].reason).toMatch(/empty/i);
	});

	it('keeps the existing extension-allowlist reject path intact', async () => {
		const POST = await importHandler();
		const form = baseForm();
		form.append('files', fileFromBuffer(Buffer.from('whatever'), 'malware.exe'));

		const req = new Request('http://localhost/api/quote', { method: 'POST', body: form });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal RequestEvent stub for this handler
		const res = await POST({ request: req } as any);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		// The extension allowlist short-circuits BEFORE the content sniff, so we
		// still get the flat "File type not allowed" error rather than the
		// structured invalid_file shape.
		expect(body.error).toMatch(/not allowed/);
	});
});
