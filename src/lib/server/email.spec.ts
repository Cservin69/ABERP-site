import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

const KEY = 'unit-test-signing-key-0123456789abcdef';
const ID = '11111111-2222-3333-4444-555555555555';

const { envState } = vi.hoisted(() => ({
	envState: {
		QUOTE_STATUS_SIGNING_KEY: 'unit-test-signing-key-0123456789abcdef'
	} as {
		QUOTE_STATUS_SIGNING_KEY?: string;
		ABERP_SITE_PUBLIC_URL?: string;
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

import { buildQuoteStatusUrl, quoteConfirmationSubject } from './email';
import { verifyQuoteToken } from './quote-token';

describe('email URL + subject builders', () => {
	beforeEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
		delete envState.ABERP_SITE_PUBLIC_URL;
	});
	afterEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
		delete envState.ABERP_SITE_PUBLIC_URL;
	});

	it('builds the default-host status URL with a token that verifies', () => {
		const url = buildQuoteStatusUrl(ID);
		expect(url.startsWith(`https://abenerp.com/q/${ID}?t=`)).toBe(true);
		const token = new URL(url).searchParams.get('t');
		expect(verifyQuoteToken(ID, token)).toBe(true);
	});

	it('honours ABERP_SITE_PUBLIC_URL and strips trailing slashes', () => {
		envState.ABERP_SITE_PUBLIC_URL = 'https://staging.abenerp.com///';
		const url = buildQuoteStatusUrl(ID);
		expect(url.startsWith(`https://staging.abenerp.com/q/${ID}?t=`)).toBe(true);
		expect(url).not.toContain('.com//q');
	});

	it('formats the confirmation subject with the short id', () => {
		expect(quoteConfirmationSubject(ID)).toBe('Ajánlat visszaigazolás 11111111');
	});
});
