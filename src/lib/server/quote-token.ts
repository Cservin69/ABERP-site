import { createHmac, timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// HMAC-SHA256 over the quote id, encoded base64url. 32-byte digest → 43 chars.
// The token is a pure, deterministic function of (id, signing key): nothing is
// persisted. Rotating QUOTE_STATUS_SIGNING_KEY invalidates every issued link at
// once — the kill switch. See PR-L brief / [[trust-code-not-operator]].
const DIGEST_BYTES = 32;

function getSigningKey(): string {
	const key = env.QUOTE_STATUS_SIGNING_KEY;
	if (!key || key.length === 0) {
		// Refuse-to-serve rather than issue forgeable links, mirroring auth.ts.
		throw error(503, 'Server is not configured: QUOTE_STATUS_SIGNING_KEY required.');
	}
	return key;
}

/** Deterministic signed token bound to a quote id. */
export function signQuoteToken(id: string): string {
	return createHmac('sha256', getSigningKey()).update(id).digest('base64url');
}

/**
 * Constant-time verification of a customer-supplied token against the recomputed
 * HMAC. HMAC is immune to length-extension; the timingSafeEqual compare on equal-
 * length buffers avoids byte-by-byte timing leakage of the expected digest.
 */
export function verifyQuoteToken(id: string, token: unknown): boolean {
	if (typeof token !== 'string' || token.length === 0) return false;

	let provided: Buffer;
	try {
		provided = Buffer.from(token, 'base64url');
	} catch {
		return false;
	}
	// A wrong length only leaks the length of the attacker's own input, not the
	// secret — but it would crash timingSafeEqual, so gate on it first.
	if (provided.length !== DIGEST_BYTES) return false;

	const expected = createHmac('sha256', getSigningKey()).update(id).digest();
	return timingSafeEqual(expected, provided);
}
