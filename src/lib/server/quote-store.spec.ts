import { describe, it, expect, afterEach } from 'vitest';

// Dynamic import so each test sees the current `process.env.ABERP_SITE_QUOTE_DIR`
// at call time — `resolveQuoteDir` reads the env on every call (not at
// module-load), so a static import works too, but this mirrors the
// catalogue-store spec and keeps the pattern uniform.
type StoreModule = typeof import('./quote-store');
async function loadStore(): Promise<StoreModule> {
	return await import('./quote-store');
}

describe('resolveQuoteDir (S356)', () => {
	const RESTORE = process.env.ABERP_SITE_QUOTE_DIR;
	afterEach(() => {
		if (RESTORE === undefined) delete process.env.ABERP_SITE_QUOTE_DIR;
		else process.env.ABERP_SITE_QUOTE_DIR = RESTORE;
	});

	it('s356_resolves_default_when_env_unset', async () => {
		const { resolveQuoteDir } = await loadStore();
		delete process.env.ABERP_SITE_QUOTE_DIR;
		expect(resolveQuoteDir()).toBe('/home/aberp/data/quotes');
	});

	it('s356_resolves_env_when_set_absolute', async () => {
		const { resolveQuoteDir } = await loadStore();
		process.env.ABERP_SITE_QUOTE_DIR = '/home/aberp/data/quotes-override';
		expect(resolveQuoteDir()).toBe('/home/aberp/data/quotes-override');
	});

	it('s356_rejects_non_absolute_env', async () => {
		const { resolveQuoteDir } = await loadStore();
		process.env.ABERP_SITE_QUOTE_DIR = './data/quotes';
		expect(() => resolveQuoteDir()).toThrow(/absolute/);
	});

	it('s356_default_path_export_matches_resolver_default', async () => {
		const { resolveQuoteDir, QUOTE_DIR_DEFAULT_PATH } = await loadStore();
		delete process.env.ABERP_SITE_QUOTE_DIR;
		expect(resolveQuoteDir()).toBe(QUOTE_DIR_DEFAULT_PATH);
	});
});
