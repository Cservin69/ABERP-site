export const QUOTE_STATUSES = [
	'received',
	'quoting',
	'quoted',
	'approved',
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
export const QUOTE_STATUS_LABELS: Record<QuoteStatus, { hu: string; en: string }> = {
	received: { hu: 'Beérkezett', en: 'Received' },
	quoting: { hu: 'Árazás folyamatban', en: 'In review' },
	quoted: { hu: 'Beárazva', en: 'Priced' },
	approved: { hu: 'Elfogadva', en: 'Accepted' },
	rejected: { hu: 'Elutasítva', en: 'Declined' },
	invoiced: { hu: 'Számlázva', en: 'Invoiced' }
};

/** Label lookup that degrades gracefully for any unexpected stored status string. */
export function quoteStatusLabel(status: string): { hu: string; en: string } {
	return isQuoteStatus(status) ? QUOTE_STATUS_LABELS[status] : { hu: status, en: status };
}
