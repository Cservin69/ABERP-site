import { createHmac, timingSafeEqual } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// HMAC-SHA256 over `${id}|${domain}[|expiry_iso]`, encoded base64url. 32-byte
// digest → 43-char string. The token is a pure, deterministic function of
// (id, domain, secret[, expiry]): nothing is persisted. Rotating
// `QUOTE_STATUS_SIGNING_KEY` invalidates every issued link at once — the kill
// switch. See PR-L (status link) + ADR-0005 (accept link) for the contract.
//
// Two domains coexist in the HMAC input:
//   - "status"  → /q/{id}?t=<token>          (no expiry, kill-switch is rotation)
//   - "accept"  → /q/{id}/accept?ts=&sig=    (30-day expiry baked into HMAC input)
//
// Domain separation prevents a status signature from being replayed as an
// accept signature even when both are issued for the same id under the same
// key. Standard pattern; no exotic crypto.
//
// Forward-compat for PR-L's pre-ADR-0005 status tokens (no marker): the verifier
// accepts BOTH the new "status"-marked form AND the legacy no-marker form. The
// legacy-acceptance arm goes away in a follow-up PR (PR-06+) once enough live
// links have rolled over.

const DIGEST_BYTES = 32;

/** 30-day accept-token lifetime per ADR-0005. */
export const ACCEPT_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Minimum signing-key length, in UTF-8 bytes. 32 bytes ≈ 256 bits — the
 * security level of the HMAC-SHA256 digest itself; a shorter key is the
 * weaker link of the chain. S285 finding F7: per [[trust-code-not-operator]]
 * an operator setting QUOTE_STATUS_SIGNING_KEY=x should not get a green light.
 */
export const MIN_SIGNING_KEY_BYTES = 32;

function getSigningKey(): string {
	const key = env.QUOTE_STATUS_SIGNING_KEY;
	if (!key || key.length === 0) {
		// Refuse-to-serve rather than issue forgeable links, mirroring auth.ts.
		throw error(503, 'Server is not configured: QUOTE_STATUS_SIGNING_KEY required.');
	}
	if (Buffer.byteLength(key, 'utf8') < MIN_SIGNING_KEY_BYTES) {
		throw error(
			503,
			`Server is not configured: QUOTE_STATUS_SIGNING_KEY must be ≥${MIN_SIGNING_KEY_BYTES} bytes (got ${Buffer.byteLength(key, 'utf8')}).`
		);
	}
	return key;
}

function hmac(material: string): Buffer {
	return createHmac('sha256', getSigningKey()).update(material).digest();
}

function decodeBase64UrlExact(token: unknown): Buffer | null {
	if (typeof token !== 'string' || token.length === 0) return null;
	let provided: Buffer;
	try {
		provided = Buffer.from(token, 'base64url');
	} catch {
		return null;
	}
	// A wrong length only leaks the length of the attacker's own input, not the
	// secret — but it would crash timingSafeEqual, so gate on it first.
	if (provided.length !== DIGEST_BYTES) return null;
	return provided;
}

// --- Status token (PR-L surface, preserved with forward-compat marker) ----

/**
 * Deterministic signed status token for a quote id. PR-04 adds the `"status"`
 * domain marker into the HMAC input; ADR-0005 says this is a one-shot wire
 * change because the verifier still accepts pre-PR-04 unmarked tokens for the
 * transition window.
 */
export function signQuoteToken(id: string): string {
	return hmac(`${id}|status`).toString('base64url');
}

/**
 * Constant-time verification of a customer-supplied status token. Accepts both
 * the new `${id}|status` shape AND the legacy `${id}`-only shape (PR-L
 * pre-ADR-0005). Both code paths run in constant time per call — neither short-
 * circuits on first-byte mismatch — so a probe cannot distinguish "valid new"
 * from "valid legacy" by timing.
 */
export function verifyQuoteToken(id: string, token: unknown): boolean {
	const provided = decodeBase64UrlExact(token);
	if (!provided) return false;
	const expectedNew = hmac(`${id}|status`);
	const newOk = timingSafeEqual(expectedNew, provided);
	const expectedLegacy = hmac(id);
	const legacyOk = timingSafeEqual(expectedLegacy, provided);
	return newOk || legacyOk;
}

// --- Accept token (ADR-0005, new in PR-04) -------------------------------

/**
 * Signs an accept token over `${id}|accept|${expiryIso}`. Expiry is BOTH baked
 * into the HMAC input AND exposed as a wire `ts=` param so the verifier can
 * read it back — otherwise an attacker could extend the URL's expiry by
 * editing `ts` and the signature would still verify. ADR-0005 §"Why expiry in
 * the URL AND in the HMAC input" covers the reasoning.
 *
 * `expiryIso` must be ISO-8601 with millisecond precision (`new Date(...).toISOString()`)
 * — the route handler reparses it, so callers must agree on the exact shape.
 */
export function signAcceptToken(id: string, expiryIso: string): string {
	return hmac(`${id}|accept|${expiryIso}`).toString('base64url');
}

/**
 * Constant-time signature check for an accept token. Returns true on match
 * regardless of whether the expiry has passed — the **expiry check is a
 * separate step in the route handler**, deliberately ordered AFTER this one
 * (ADR-0005 §"Verification order"). Doing both checks in one function would
 * collapse the two outcomes ("invalid signature" vs "valid signature but
 * expired") into one boolean and leak which expiries were ever issued.
 */
export function verifyAcceptToken(id: string, expiryIso: string, token: unknown): boolean {
	const provided = decodeBase64UrlExact(token);
	if (!provided) return false;
	const expected = hmac(`${id}|accept|${expiryIso}`);
	return timingSafeEqual(expected, provided);
}

/**
 * Issue-time helper: returns the ISO-8601 expiry stamp 30 days from `nowMs`,
 * the exact string both `signAcceptToken` and the wire URL bake in.
 */
export function defaultAcceptExpiryIso(nowMs: number): string {
	return new Date(nowMs + ACCEPT_TOKEN_LIFETIME_MS).toISOString();
}
