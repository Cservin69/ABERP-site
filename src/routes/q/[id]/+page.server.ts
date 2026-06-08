import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { readQuote } from '$lib/server/quote-store';
import { verifyQuoteToken } from '$lib/server/quote-token';
import { quoteStatusLabel } from '$lib/server/quote-status';

export const prerender = false;
export const ssr = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Target response window for an early-stage quote, in days from receipt. Shown as
// a soft SLA only while the quote is still pre-pricing.
const SLA_DAYS = 2;
const EARLY_STATUSES = new Set(['received', 'quoting']);

export const load: PageServerLoad = async ({ params, url }) => {
	const id = params.id ?? '';
	const token = url.searchParams.get('t');

	// Every failure path returns the same 404 so the page never confirms whether
	// an id exists: no id-only enumeration, no PII leak. The token is the gate.
	if (!UUID_RE.test(id)) throw error(404, 'Not found.');
	if (!token || !verifyQuoteToken(id, token)) throw error(404, 'Not found.');

	const quote = await readQuote(id);
	if (!quote) throw error(404, 'Not found.');

	const label = quoteStatusLabel(quote.status);

	let expectedResponseBy: string | null = null;
	if (EARLY_STATUSES.has(quote.status) && quote.received_at) {
		const received = new Date(quote.received_at);
		if (!Number.isNaN(received.getTime())) {
			received.setUTCDate(received.getUTCDate() + SLA_DAYS);
			expectedResponseBy = received.toISOString();
		}
	}

	// Labels are resolved here, server-side: $lib/server modules cannot be imported
	// by the client component, so the page receives plain, display-ready data.
	const history = (quote.status_history ?? []).map((h) => ({
		at: h.at,
		fromLabel: quoteStatusLabel(h.from),
		toLabel: quoteStatusLabel(h.to)
	}));

	// Pricing surface — only set when ABERP has written back. The PDF URL re-uses
	// the same status token so the customer's existing link works for both views.
	const pricing = quote.pricing
		? {
				valid_until: quote.pricing.valid_until,
				stock_alert: quote.pricing.stock_alert === true,
				pdf_url: `/api/quotes/${encodeURIComponent(id)}/pdf?t=${encodeURIComponent(token)}`
			}
		: null;

	const pricingPending = !pricing && EARLY_STATUSES.has(quote.status);

	// Read-only projection — deliberately omits files, internal request notes, and
	// any operator-action affordance. Customer sees only what confirms ownership +
	// progress.
	return {
		quote: {
			id: quote.id,
			status: quote.status,
			statusLabel: label,
			received_at: quote.received_at,
			contact: {
				name: quote.contact.name,
				email: quote.contact.email
			},
			history,
			receivedLabel: quoteStatusLabel('received'),
			pricing,
			pricingPending
		},
		expectedResponseBy
	};
};
