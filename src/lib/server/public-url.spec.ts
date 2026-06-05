import { describe, it, expect, vi, beforeEach } from 'vitest';

const { envState, envFlags } = vi.hoisted(() => ({
	envState: {} as { ABERP_SITE_PUBLIC_URL?: string },
	envFlags: { dev: false, building: false }
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
		return envFlags.dev;
	},
	get building() {
		return envFlags.building;
	}
}));

import { publicSiteUrl } from './public-url';

describe('publicSiteUrl — fail-closed (PR-R)', () => {
	beforeEach(() => {
		delete envState.ABERP_SITE_PUBLIC_URL;
		envFlags.dev = false;
		envFlags.building = false;
	});

	it('throws in production when ABERP_SITE_PUBLIC_URL is unset', () => {
		expect(() => publicSiteUrl()).toThrow(
			/ABERP_SITE_PUBLIC_URL must be set in production\. See docs\/deploy\.md\./
		);
	});

	it('throws in production when ABERP_SITE_PUBLIC_URL is a blank string', () => {
		envState.ABERP_SITE_PUBLIC_URL = '   ';
		expect(() => publicSiteUrl()).toThrow(/must be set in production/);
	});

	it('throws in production when ABERP_SITE_PUBLIC_URL is an empty string', () => {
		envState.ABERP_SITE_PUBLIC_URL = '';
		expect(() => publicSiteUrl()).toThrow(/must be set in production/);
	});

	it('returns the configured URL in production when set', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com';
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});

	it('returns a staging URL in production when set', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://staging.abenerp.com';
		expect(publicSiteUrl()).toBe('https://staging.abenerp.com');
	});

	it('strips a trailing slash from the configured URL', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com/';
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});

	it('strips multiple trailing slashes from the configured URL', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://abenerp.com///';
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});

	it('returns the default in dev when ABERP_SITE_PUBLIC_URL is unset', () => {
		envFlags.dev = true;
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});

	it('does not throw in dev with a blank env', () => {
		envFlags.dev = true;
		envState.ABERP_SITE_PUBLIC_URL = '';
		expect(() => publicSiteUrl()).not.toThrow();
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});

	it('honours the configured URL over the default in dev', () => {
		envFlags.dev = true;
		envState.ABERP_SITE_PUBLIC_URL = 'http://localhost:5173';
		expect(publicSiteUrl()).toBe('http://localhost:5173');
	});

	it('returns the default during build/prerender (building=true) without throwing', () => {
		envFlags.building = true;
		expect(() => publicSiteUrl()).not.toThrow();
		expect(publicSiteUrl()).toBe('https://abenerp.com');
	});
});
