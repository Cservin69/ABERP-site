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

// S403 — operator REFUSE-with-reason. ABERP's refuse action writes back
// the `rejected` status carrying the operator's reason as the transition
// `notes`. (`rejected` is reused deliberately — it already means
// "operator-side decline"; a parallel `refused` status would duplicate
// it. The customer also receives the reason by e-mail; this surfaces it
// on the portal.) The reason is rendered on the public status page when
// present.

/** Defensive cap on the rendered reason length. The server validates the
 * reason at ≤2000 chars, but the portal truncates so a pathological value
 * never blows out the layout. */
export const REFUSAL_REASON_DISPLAY_MAX = 280;

/** Extract the operator's refusal reason from the status history: the
 * `notes` of the most recent transition INTO `rejected`. Returns `null`
 * when there is no such transition or it carried no note. */
export function extractRefusalReason(
	history: { to: string; notes?: string }[] | undefined | null
): string | null {
	if (!history) return null;
	for (let i = history.length - 1; i >= 0; i--) {
		const h = history[i];
		if (h.to === 'rejected' && typeof h.notes === 'string' && h.notes.trim().length > 0) {
			return h.notes.trim();
		}
	}
	return null;
}

/** Truncate a reason for display, appending an ellipsis when clipped. */
export function truncateRefusalReason(
	reason: string,
	max: number = REFUSAL_REASON_DISPLAY_MAX
): string {
	const trimmed = reason.trim();
	if (trimmed.length <= max) return trimmed;
	return trimmed.slice(0, max).trimEnd() + '…';
}
