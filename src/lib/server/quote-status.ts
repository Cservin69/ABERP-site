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
