import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { createHmac } from 'node:crypto';

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

import {
	signQuoteToken,
	verifyQuoteToken,
	signAcceptToken,
	verifyAcceptToken,
	defaultAcceptExpiryIso,
	ACCEPT_TOKEN_LIFETIME_MS
} from './quote-token';

describe('quote-token — status surface', () => {
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

	it('verifier accepts legacy PR-L no-domain-marker tokens during the transition window', () => {
		// Pre-ADR-0005 wire shape — HMAC over `id` with no "|status" suffix.
		const legacy = createHmac('sha256', KEY).update(ID).digest('base64url');
		expect(verifyQuoteToken(ID, legacy)).toBe(true);
	});
});

describe('quote-token — accept surface (ADR-0005)', () => {
	const EXPIRY = '2099-12-31T00:00:00.000Z';

	beforeEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
	});
	afterEach(() => {
		envState.QUOTE_STATUS_SIGNING_KEY = KEY;
	});

	it('signs deterministically with id + expiry mixed into the HMAC input', () => {
		const a = signAcceptToken(ID, EXPIRY);
		const b = signAcceptToken(ID, EXPIRY);
		expect(a).toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('verifies a freshly signed token under the matching id + expiry', () => {
		const token = signAcceptToken(ID, EXPIRY);
		expect(verifyAcceptToken(ID, EXPIRY, token)).toBe(true);
	});

	it('rejects a tampered expiry — extending the URL would invalidate the signature', () => {
		const token = signAcceptToken(ID, EXPIRY);
		expect(verifyAcceptToken(ID, '2099-12-31T00:00:01.000Z', token)).toBe(false);
	});

	it('rejects a tampered id', () => {
		const token = signAcceptToken(ID, EXPIRY);
		expect(verifyAcceptToken('99999999-2222-3333-4444-555555555555', EXPIRY, token)).toBe(false);
	});

	it('rejects a tampered signature', () => {
		const token = signAcceptToken(ID, EXPIRY);
		const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
		expect(verifyAcceptToken(ID, EXPIRY, flipped)).toBe(false);
	});

	it('still returns true on signature match even when expiry is in the past — route enforces expiry separately', () => {
		const past = '2000-01-01T00:00:00.000Z';
		const token = signAcceptToken(ID, past);
		// Per ADR-0005 §"Verification order" — the verifier is signature-only by
		// design so the route handler can return 403 for both bad-sig and expired
		// in the same code path, without leaking which one failed.
		expect(verifyAcceptToken(ID, past, token)).toBe(true);
	});

	it('rejects non-string, empty, and wrong-length inputs without throwing', () => {
		expect(verifyAcceptToken(ID, EXPIRY, undefined)).toBe(false);
		expect(verifyAcceptToken(ID, EXPIRY, '')).toBe(false);
		expect(verifyAcceptToken(ID, EXPIRY, 'too-short')).toBe(false);
	});

	it('domain-separation: a status-token signature does not verify as an accept-token signature', () => {
		const statusToken = signQuoteToken(ID);
		expect(verifyAcceptToken(ID, EXPIRY, statusToken)).toBe(false);
	});

	it('domain-separation: an accept-token signature does not verify as a status-token signature', () => {
		const acceptToken = signAcceptToken(ID, EXPIRY);
		expect(verifyQuoteToken(ID, acceptToken)).toBe(false);
	});

	it('defaultAcceptExpiryIso produces a 30-day-out ISO stamp from the given clock', () => {
		const now = Date.parse('2026-01-01T00:00:00.000Z');
		const expiry = defaultAcceptExpiryIso(now);
		expect(expiry).toBe(new Date(now + ACCEPT_TOKEN_LIFETIME_MS).toISOString());
		expect(Date.parse(expiry) - now).toBe(30 * 24 * 60 * 60 * 1000);
	});
});
