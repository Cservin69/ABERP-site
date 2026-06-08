import { env } from '$env/dynamic/private';

/**
 * Thin HTTPS client for ABERP's `POST /api/internal/send-email` relay endpoint
 * (ADR-0007). SERVER-ONLY: imports `$env/dynamic/private` and must never be
 * pulled into `.svelte` / `+page.ts` components.
 *
 * Why this exists: ADR-0007 supersedes ADR-0006 — the storefront no longer
 * holds SMTP credentials. Outbound customer mail goes through ABERP so a
 * single SMTP identity / SPF / DKIM / audit lineage covers every surface
 * ([[aberp-smtp-spoc]] enforced architecturally, not by value-duplication).
 *
 * Per ADR-0007 §"Negative" the storefront persists+queues on 5xx so a brief
 * ABERP outage doesn't drop mail; v1 in this PR exposes typed errors and lets
 * the caller decide (the priced-writeback handler swallows + logs; the accept
 * action records the failure without rolling back the state transition).
 */

export interface EmailAttachment {
	/** Display filename only. Header-injection-safe characters please. */
	filename: string;
	/** MIME type, e.g. `application/pdf`. */
	content_type: string;
	/** Base64-encoded attachment bytes. */
	data_b64: string;
}

export interface EmailSendRequest {
	to: string[];
	cc?: string[];
	subject: string;
	body_text: string;
	body_html?: string;
	attachments?: EmailAttachment[];
}

export interface EmailSendResponse {
	audit_id: string;
}

export type EmailRelayErrorKind =
	| 'unconfigured'
	| 'unauthorized'
	| 'bad_request'
	| 'too_large'
	| 'rate_limited'
	| 'unavailable'
	| 'network'
	| 'malformed_response';

export class EmailRelayError extends Error {
	constructor(
		public readonly kind: EmailRelayErrorKind,
		public readonly status?: number,
		message?: string
	) {
		super(message ?? kind);
		this.name = 'EmailRelayError';
	}
}

/**
 * True when both the relay base URL and bearer token are present in env. Used
 * by callers that prefer a silent no-op over a thrown unconfigured error
 * (parity with the prior `isEmailConfigured()` posture on `email.ts`).
 */
export function isEmailRelayConfigured(): boolean {
	const base = (env.ABERP_INTERNAL_BASE_URL ?? '').trim();
	const token = (env.ABERP_EMAIL_RELAY_TOKEN ?? '').trim();
	return base.length > 0 && token.length > 0;
}

function relayEndpoint(): string {
	const raw = (env.ABERP_INTERNAL_BASE_URL ?? '').trim();
	return raw.replace(/\/+$/, '') + '/api/internal/send-email';
}

/**
 * Sends one email through ABERP's relay endpoint. Never falls back to a local
 * SMTP path — ADR-0007's single-sender invariant requires the relay to be the
 * only egress.
 *
 * Throws `EmailRelayError` on every non-200 outcome. The kind discriminates
 * what to tell the caller: `unauthorized` and `bad_request` are storefront
 * bugs (log loudly); `too_large` / `rate_limited` / `unavailable` are
 * recoverable upstream conditions (queue/retry); `network` covers DNS, TCP,
 * TLS, and timeouts.
 */
export async function sendEmailViaABERP(req: EmailSendRequest): Promise<EmailSendResponse> {
	if (!isEmailRelayConfigured()) {
		throw new EmailRelayError('unconfigured', undefined, 'ABERP relay env not set');
	}
	const token = (env.ABERP_EMAIL_RELAY_TOKEN ?? '').trim();
	const url = relayEndpoint();

	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(req)
		});
	} catch (err) {
		throw new EmailRelayError('network', undefined, String(err));
	}

	if (res.status === 200) {
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			throw new EmailRelayError('malformed_response', 200);
		}
		if (
			!body ||
			typeof body !== 'object' ||
			typeof (body as { audit_id?: unknown }).audit_id !== 'string'
		) {
			throw new EmailRelayError('malformed_response', 200);
		}
		return { audit_id: (body as { audit_id: string }).audit_id };
	}

	if (res.status === 401) throw new EmailRelayError('unauthorized', 401);
	if (res.status === 400) throw new EmailRelayError('bad_request', 400);
	if (res.status === 413) throw new EmailRelayError('too_large', 413);
	if (res.status === 429) throw new EmailRelayError('rate_limited', 429);
	if (res.status === 503) throw new EmailRelayError('unavailable', 503);
	throw new EmailRelayError('unavailable', res.status, `unexpected status ${res.status}`);
}
