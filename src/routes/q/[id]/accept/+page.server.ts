import { error, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { readQuote, writeQuoteAtomic, type QuoteMetadata } from '$lib/server/quote-store';
import { verifyAcceptToken } from '$lib/server/quote-token';
import { quoteStatusLabel } from '$lib/server/quote-status';
import { sendAcceptedConfirmationEmail } from '$lib/server/email';

export const prerender = false;
export const ssr = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The literal token the customer must type into the form to commit acceptance.
 * Mirrors the operator-side DEAL/STORNO pattern per `[[hulye-biztos]]` and
 * addendum 3 (customer analog). Case-sensitive, ASCII-only.
 */
const ACCEPT_TOKEN = 'ACCEPT';

interface CustomerProjection {
	id: string;
	shortId: string;
	contact: { name: string; email: string };
	pricing: {
		valid_until: string;
		stock_alert: boolean;
		pdf_url: string | null;
	} | null;
	statusLabel: { hu: string; en: string };
}

function projectForCustomer(q: QuoteMetadata, statusToken: string | null): CustomerProjection {
	return {
		id: q.id,
		shortId: q.id.slice(0, 8),
		contact: { name: q.contact.name, email: q.contact.email },
		pricing: q.pricing
			? {
					valid_until: q.pricing.valid_until,
					stock_alert: q.pricing.stock_alert === true,
					// The accept route is HMAC-signed and only the holder of the email
					// link can read it. The PDF inline-view link uses the read-only
					// status token; we generate one only if we have a status token
					// already in scope. The accept link itself does NOT grant PDF
					// access — that link comes from the priced-ready email.
					pdf_url:
						statusToken !== null
							? `/api/quotes/${encodeURIComponent(q.id)}/pdf?t=${encodeURIComponent(statusToken)}`
							: null
				}
			: null,
		statusLabel: quoteStatusLabel(q.status)
	};
}

// ADR-0005 §"Verification order" — HMAC first, then expiry, then state. A
// signature mismatch must return 403 regardless of expiry so a probe cannot
// distinguish "valid sig, expired" from "invalid sig" by status code.
function verifySignedLink(id: string, ts: string, sig: string): void {
	if (!verifyAcceptToken(id, ts, sig)) {
		throw error(403, 'Invalid accept link.');
	}
	const expiryMs = Date.parse(ts);
	if (!Number.isFinite(expiryMs)) {
		// A malformed ts that still happens to verify is an honest-server bug —
		// fail closed.
		throw error(403, 'Invalid accept link.');
	}
	if (expiryMs <= Date.now()) {
		throw error(403, 'This accept link has expired.');
	}
}

export const load: PageServerLoad = async ({ params, url }) => {
	const id = params.id ?? '';
	const ts = url.searchParams.get('ts') ?? '';
	const sig = url.searchParams.get('sig') ?? '';

	// Every malformed-id case returns 404 so the page never confirms whether
	// an id exists. The signature is the real gate.
	if (!UUID_RE.test(id)) throw error(404, 'Not found.');
	if (!ts || !sig) throw error(404, 'Not found.');

	verifySignedLink(id, ts, sig);

	const quote = await readQuote(id);
	if (!quote) throw error(404, 'Not found.');

	// Idempotent landing: a re-clicked link on an already-approved quote shows
	// the "already accepted" page instead of a hard 409 (ADR-0005 §"Single-use
	// enforcement" — the customer-facing surface renders this friendly).
	if (quote.status === 'approved') {
		return {
			view: 'already-approved' as const,
			quote: projectForCustomer(quote, null),
			expiryTs: ts
		};
	}

	// We only show the accept form when the quote is in `quoted`. Other states
	// (received/quoting → no priced PDF yet; rejected/invoiced → terminal) are
	// not reachable on this page.
	if (quote.status !== 'quoted') {
		throw error(409, 'This quote cannot be accepted in its current state.');
	}
	if (!quote.pricing) {
		throw error(409, 'This quote has no priced record yet.');
	}

	return {
		view: 'confirm' as const,
		quote: projectForCustomer(quote, null),
		expiryTs: ts,
		acceptToken: ACCEPT_TOKEN
	};
};

export const actions: Actions = {
	default: async ({ params, url, request }) => {
		const id = params.id ?? '';
		const ts = url.searchParams.get('ts') ?? '';
		const sig = url.searchParams.get('sig') ?? '';

		if (!UUID_RE.test(id)) throw error(404, 'Not found.');
		if (!ts || !sig) throw error(404, 'Not found.');

		// Re-validate on POST so a captured `?ts=&sig=` from a page load cannot
		// be re-played after expiry without the page being re-loaded too.
		verifySignedLink(id, ts, sig);

		const form = await request.formData();
		const typed = (form.get('accept_token') ?? '').toString();
		if (typed !== ACCEPT_TOKEN) {
			return fail(400, {
				error: `You must type ${ACCEPT_TOKEN} exactly to confirm.`,
				typed
			});
		}

		const existing = await readQuote(id);
		if (!existing) throw error(404, 'Not found.');

		// Idempotent replay: a second valid POST on an already-approved quote
		// returns the "accepted" state without re-writing the file or re-sending
		// the confirmation email. No double-write, no double-relay.
		if (existing.status === 'approved') {
			return { accepted: true, alreadyApproved: true };
		}

		if (existing.status !== 'quoted') {
			throw error(409, 'This quote cannot be accepted in its current state.');
		}

		const now = new Date().toISOString();

		// Send the confirmation email BEFORE flipping state so the audit_id can be
		// persisted in the same write. An email-relay failure does NOT roll back
		// the acceptance — the quote IS accepted as soon as the customer typed
		// the token; the email is a courtesy. `acceptance_audit_id` is left unset
		// when the relay was unconfigured / unavailable.
		let acceptanceAuditId: string | undefined;
		try {
			const r = await sendAcceptedConfirmationEmail(existing);
			if (r.status === 'sent' && r.audit_id) {
				acceptanceAuditId = r.audit_id;
			} else if (r.status === 'failed') {
				console.error('[accept] confirmation-email relay failed:', r.reason);
			}
		} catch (err) {
			console.error('[accept] confirmation-email threw unexpectedly:', err);
		}

		const updated: QuoteMetadata = {
			...existing,
			status: 'approved',
			accepted_at: now,
			acceptance_signature_ts: ts,
			acceptance_audit_id: acceptanceAuditId,
			status_history: [
				...(existing.status_history ?? []),
				{
					at: now,
					from: 'quoted',
					to: 'approved',
					notes: `Customer accepted via /q/${id}/accept on ${now.slice(0, 10)}`
				}
			]
		};
		await writeQuoteAtomic(id, updated);

		return { accepted: true, alreadyApproved: false };
	}
};
