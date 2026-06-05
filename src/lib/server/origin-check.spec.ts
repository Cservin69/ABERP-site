import { describe, it, expect, vi, beforeEach } from 'vitest';

const { envState, devState } = vi.hoisted(() => ({
	envState: {} as { ABERP_SITE_PUBLIC_URL?: string },
	devState: { dev: false }
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));
vi.mock('$app/environment', () => ({
	get dev() {
		return devState.dev;
	}
}));

import { checkOrigin, assertSameOrigin } from './origin-check';

function reqWith(origin: string | null): Request {
	const headers = new Headers();
	if (origin !== null) headers.set('origin', origin);
	return new Request('http://localhost/api/quote', { method: 'POST', headers });
}

describe('checkOrigin', () => {
	beforeEach(() => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com';
		devState.dev = false;
	});

	it('allows a request matching ABERP_SITE_PUBLIC_URL exactly', () => {
		const verdict = checkOrigin(reqWith('https://abenerp.com'));
		expect(verdict.ok).toBe(true);
		expect(verdict.expected).toEqual(['https://abenerp.com']);
	});

	it('rejects a request from a different host in production', () => {
		const verdict = checkOrigin(reqWith('https://evil.example.com'));
		expect(verdict.ok).toBe(false);
		expect(verdict.expected).toEqual(['https://abenerp.com']);
		expect(verdict.got).toBe('https://evil.example.com');
	});

	it('rejects localhost in production (no dev carve-out)', () => {
		const verdict = checkOrigin(reqWith('http://localhost:5173'));
		expect(verdict.ok).toBe(false);
	});

	it('allows localhost variants in dev', () => {
		devState.dev = true;
		expect(checkOrigin(reqWith('http://localhost:5173')).ok).toBe(true);
		expect(checkOrigin(reqWith('http://127.0.0.1:5173')).ok).toBe(true);
		expect(checkOrigin(reqWith('http://localhost:4173')).ok).toBe(true);
	});

	it('still rejects an unknown host in dev', () => {
		devState.dev = true;
		expect(checkOrigin(reqWith('https://evil.example.com')).ok).toBe(false);
	});

	it('passes when the Origin header is absent (server-side traffic)', () => {
		const verdict = checkOrigin(reqWith(null));
		expect(verdict.ok).toBe(true);
		expect(verdict.got).toBe(null);
	});

	it('strips a trailing slash on the configured URL when comparing', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com/';
		expect(checkOrigin(reqWith('https://abenerp.com')).ok).toBe(true);
	});
});

describe('assertSameOrigin', () => {
	beforeEach(() => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com';
		devState.dev = false;
	});

	it('returns null when the Origin matches (so callers proceed)', () => {
		expect(assertSameOrigin(reqWith('https://abenerp.com'))).toBeNull();
	});

	it('returns a 403 JSON Response with the structured payload on mismatch', async () => {
		const resp = assertSameOrigin(reqWith('https://evil.example.com'));
		expect(resp).not.toBeNull();
		expect(resp!.status).toBe(403);
		const body = (await resp!.json()) as {
			error: string;
			expected: string[];
			got: string;
		};
		expect(body.error).toBe('origin_mismatch');
		expect(body.expected).toEqual(['https://abenerp.com']);
		expect(body.got).toBe('https://evil.example.com');
	});
});
