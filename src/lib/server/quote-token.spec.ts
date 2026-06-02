import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';

const KEY = 'unit-test-signing-key-0123456789abcdef';
const ID = '11111111-2222-3333-4444-555555555555';

const { envState } = vi.hoisted(() => ({
	envState: { QUOTE_STATUS_SIGNING_KEY: 'unit-test-signing-key-0123456789abcdef' } as {
		QUOTE_STATUS_SIGNING_KEY?: string;
	}
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

import { signQuoteToken, verifyQuoteToken } from './quote-token';

describe('quote-token', () => {
	beforeEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
	});
	afterEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
	});

	it('signs deterministically to a 43-char base64url token (32-byte digest)', () => {
		const a = signQuoteToken(ID);
		const b = signQuoteToken(ID);
		expect(a).toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('verifies a freshly signed token for the same id', () => {
		const token = signQuoteToken(ID);
		expect(verifyQuoteToken(ID, token)).toBe(true);
	});

	it('rejects a token issued for a different id (no cross-quote reuse)', () => {
		const token = signQuoteToken(ID);
		expect(verifyQuoteToken('99999999-2222-3333-4444-555555555555', token)).toBe(false);
	});

	it('rejects a tampered token', () => {
		const token = signQuoteToken(ID);
		const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
		expect(verifyQuoteToken(ID, flipped)).toBe(false);
	});

	it('rejects non-string, empty, and wrong-length inputs without throwing', () => {
		expect(verifyQuoteToken(ID, undefined)).toBe(false);
		expect(verifyQuoteToken(ID, '')).toBe(false);
		expect(verifyQuoteToken(ID, 'too-short')).toBe(false);
		expect(verifyQuoteToken(ID, '!!!not-base64!!!')).toBe(false);
	});

	it('changes the token when the signing key rotates (rotation = kill switch)', () => {
		const before = signQuoteToken(ID);
		envState.QUOTE_STATUS_SIGNING_KEY = 'a-completely-different-rotated-key-value';
		const after = signQuoteToken(ID);
		expect(after).not.toBe(before);
		// Old link no longer verifies under the new key.
		expect(verifyQuoteToken(ID, before)).toBe(false);
	});

	it('throws 503 when QUOTE_STATUS_SIGNING_KEY is unset (refuse-to-serve)', () => {
		delete envState.QUOTE_STATUS_SIGNING_KEY;
		try {
			signQuoteToken(ID);
			expect.unreachable('expected 503 to throw');
		} catch (err) {
			expect((err as { status: number }).status).toBe(503);
		}
	});
});
