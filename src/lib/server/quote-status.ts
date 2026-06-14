export const QUOTE_STATUSES = [
	'received',
	'quoting',
	'quoted',
	'approved',
	'processing',
	'rejected',
	'invoiced'
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_SET = new Set<string>(QUOTE_STATUSES);

export function isQuoteStatus(value: unknown): value is QuoteStatus {
	return typeof value === 'string' && QUOTE_STATUS_SET.has(value);
}

// Customer-facing HU+EN labels for the public status page. Pure data, safe to
// import on the client.
//
// S398 — the ladder reflects *ledger truth*, never a forward-derived next step
// (the Bug #3 misrepresentation: ABERP's intake daemon flipped the customer
// status to `invoiced` the instant it auto-staged an internal DRAFT invoice,
// pre-DEAL, with no fiscal invoice in existence). The two states between accept
// and a real invoice are now distinct:
//   - `approved`   — customer typed ACCEPT; ABERP has not yet picked it up.
//   - `processing` — ABERP's intake ingested the acceptance and staged a draft
//                    for the operator. NOT confirmed (no DEAL), NOT invoiced.
//   - `invoiced`   — a real fiscal invoice ledger event exists (ABERP writes
//                    this only on actual issuance; see the status writeback
//                    state machine).
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, { hu: string; en: string }> = {
	received: { hu: 'Beérkezett', en: 'Received' },
	quoting: { hu: 'Árazás folyamatban', en: 'In review' },
	quoted: { hu: 'Beárazva', en: 'Priced' },
	approved: { hu: 'Elfogadva — várjuk a megerősítést', en: 'Accepted — awaiting confirmation' },
	processing: { hu: 'Feldolgozás alatt', en: 'In progress' },
	rejected: { hu: 'Elutasítva', en: 'Declined' },
	invoiced: { hu: 'Számlázva', en: 'Invoiced' }
};

/** Label lookup that degrades gracefully for any unexpected stored status string. */
export function quoteStatusLabel(status: string): { hu: string; en: string } {
	return isQuoteStatus(status) ? QUOTE_STATUS_LABELS[status] : { hu: status, en: status };
}
