import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Cookies } from '@sveltejs/kit';

const TOKEN = 'unit-test-admin-token';

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

import { ADMIN_COOKIE, requireAdminCookieOrError } from './auth';

function mockCookies(value: string | undefined): Cookies {
	const store = new Map<string, string>();
	if (value !== undefined) store.set(ADMIN_COOKIE, value);
	return {
		get: (name: string) => store.get(name),
		getAll: () => Array.from(store, ([name, val]) => ({ name, value: val })),
		set: () => {},
		delete: () => {},
		serialize: () => ''
	} as unknown as Cookies;
}

describe('requireAdminCookieOrError', () => {
	beforeEach(() => {
		envState.ABERP_SITE_ADMIN_TOKEN = TOKEN;
	});

	afterEach(() => {
		envState.ABERP_SITE_ADMIN_TOKEN = TOKEN;
	});

	it('throws 401 when no cookie is set', () => {
		const cookies = mockCookies(undefined);
		try {
			requireAdminCookieOrError(cookies);
			expect.unreachable('expected error to throw');
		} catch (err) {
			expect((err as { status: number }).status).toBe(401);
		}
	});

	it('throws 401 when cookie value does not match the configured token', () => {
		const cookies = mockCookies('wrong-token-value');
		try {
			requireAdminCookieOrError(cookies);
			expect.unreachable('expected error to throw');
		} catch (err) {
			expect((err as { status: number }).status).toBe(401);
		}
	});

	it('throws 401 when cookie value differs in length (timing-safe compare)', () => {
		const cookies = mockCookies(TOKEN.slice(0, -1));
		try {
			requireAdminCookieOrError(cookies);
			expect.unreachable('expected error to throw');
		} catch (err) {
			expect((err as { status: number }).status).toBe(401);
		}
	});

	it('returns void when cookie matches the configured token', () => {
		const cookies = mockCookies(TOKEN);
		expect(() => requireAdminCookieOrError(cookies)).not.toThrow();
	});

	it('throws 503 when ABERP_SITE_ADMIN_TOKEN is unset (refuse-to-start)', () => {
		delete envState.ABERP_SITE_ADMIN_TOKEN;
		const cookies = mockCookies(TOKEN);
		try {
			requireAdminCookieOrError(cookies);
			expect.unreachable('expected 503 error to throw');
		} catch (err) {
			expect((err as { status: number }).status).toBe(503);
		}
	});
});
