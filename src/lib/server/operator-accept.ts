/**
 * S354 / ADR-0005 amendment — operator accept-on-behalf signature.
 *
 * When a customer accepts a quote off-channel (phone / e-mail / in person)
 * instead of clicking the unique DEAL link, ABERP records the acceptance on
 * the customer's behalf and POSTs `status: 'operator_accepted'` to
 * `/api/quotes/[id]/status` over its Bearer **plus** an HMAC signature. The
 * status handler permits the otherwise-forbidden `approved` transition only
 * when BOTH the Bearer AND this HMAC validate — so an operator-accept is
 * provably ABERP-originated and the bound fields cannot be tampered.
 *
 * ## Which secret
 *
 * The HMAC key is `ABERP_SITE_ADMIN_TOKEN` — the **same** Bearer secret the
 * priced / status writebacks already authenticate against. ABERP possesses
 * that token (it presents it on every writeback) but NOT the customer-token
 * `QUOTE_STATUS_SIGNING_KEY`, so the Bearer is the only secret shared
 * between the two services. The Bearer already authenticates the request;
 * the HMAC's job is to (a) bind the semantic fields so they can't be
 * tampered independently of the token and (b) gate the forbidden
 * `operator_accepted` transition behind an explicit signed proof, keeping it
 * distinct from the plain-Bearer `approved` the handler still refuses.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';

export const OPERATOR_ACCEPT_CHANNELS = ['phone', 'email', 'in_person', 'other'] as const;
export type OperatorAcceptChannel = (typeof OPERATOR_ACCEPT_CHANNELS)[number];

export function isOperatorAcceptChannel(value: unknown): value is OperatorAcceptChannel {
	return (
		typeof value === 'string' && (OPERATOR_ACCEPT_CHANNELS as readonly string[]).includes(value)
	);
}

/**
 * Canonical HMAC message. MUST match ABERP's `operator_accept_canonical`
 * byte-for-byte. The literal `operator_accept` is the domain separator
 * (mirrors ADR-0005's `status` / `accept` markers) so an operator-accept
 * signature can never be replayed as a status- or accept-token.
 */
export function operatorAcceptCanonicalMessage(
	quoteId: string,
	channel: string,
	acceptedAtMs: number,
	operatorUserId: string
): string {
	return `${quoteId}|operator_accept|${channel}|${acceptedAtMs}|${operatorUserId}`;
}

function getBearerSecret(): string {
	const token = env.ABERP_SITE_ADMIN_TOKEN;
	if (!token || token.length === 0) {
		throw error(503, 'Server is not configured: ABERP_SITE_ADMIN_TOKEN required.');
	}
	return token;
}

/** Lowercase-hex HMAC-SHA256 over the canonical message, keyed by the Bearer secret. */
export function operatorAcceptSignature(
	quoteId: string,
	channel: string,
	acceptedAtMs: number,
	operatorUserId: string
): string {
	const msg = operatorAcceptCanonicalMessage(quoteId, channel, acceptedAtMs, operatorUserId);
	return createHmac('sha256', getBearerSecret()).update(msg).digest('hex');
}

/**
 * Constant-time verify of a hex signature against the recomputed HMAC.
 * Returns `false` (never throws) for a missing / malformed / mismatched
 * signature so the handler maps it to a flat 401.
 */
export function verifyOperatorAcceptSignature(
	quoteId: string,
	channel: string,
	acceptedAtMs: number,
	operatorUserId: string,
	providedHex: unknown
): boolean {
	if (typeof providedHex !== 'string' || !/^[0-9a-f]{64}$/.test(providedHex)) return false;
	const expected = Buffer.from(
		operatorAcceptSignature(quoteId, channel, acceptedAtMs, operatorUserId),
		'hex'
	);
	const provided = Buffer.from(providedHex, 'hex');
	if (expected.length !== provided.length) return false;
	return timingSafeEqual(expected, provided);
}
