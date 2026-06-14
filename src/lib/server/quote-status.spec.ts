import { describe, it, expect } from 'vitest';
import {
	QUOTE_STATUSES,
	QUOTE_STATUS_LABELS,
	REFUSAL_REASON_DISPLAY_MAX,
	extractRefusalReason,
	isQuoteStatus,
	quoteStatusLabel,
	truncateRefusalReason
} from './quote-status';

// S398 — the customer-facing status mapper is the surface Bug #3 manifested on:
// a not-yet-invoiced quote was rendered "Számlázva / Invoiced". These tests pin
// the ledger-truthful ladder so the mapping can't silently regress.

describe('quote-status — ledger-truthful customer labels (S398)', () => {
	it('includes the `processing` way-station between accepted and invoiced', () => {
		expect(QUOTE_STATUSES).toContain('processing');
		expect(isQuoteStatus('processing')).toBe(true);
		expect(quoteStatusLabel('processing')).toEqual({
			hu: 'Feldolgozás alatt',
			en: 'In progress'
		});
	});

	it('labels `approved` as awaiting-confirmation, NOT invoiced (Bug #3 guard)', () => {
		const label = quoteStatusLabel('approved');
		// The whole point: an accepted-but-not-invoiced quote must never read as
		// a fiscal invoice on the customer portal.
		expect(label.hu).not.toContain('Számlázva');
		expect(label.en).not.toContain('Invoiced');
		expect(label).toEqual({
			hu: 'Elfogadva — várjuk a megerősítést',
			en: 'Accepted — awaiting confirmation'
		});
	});

	it('reserves "Számlázva / Invoiced" for the `invoiced` status only', () => {
		expect(quoteStatusLabel('invoiced')).toEqual({ hu: 'Számlázva', en: 'Invoiced' });
		// No other status may carry the invoiced wording.
		for (const status of QUOTE_STATUSES) {
			if (status === 'invoiced') continue;
			const { hu, en } = QUOTE_STATUS_LABELS[status];
			expect(hu).not.toBe('Számlázva');
			expect(en).not.toBe('Invoiced');
		}
	});

	it('degrades gracefully for an unknown stored status', () => {
		expect(quoteStatusLabel('nonsense')).toEqual({ hu: 'nonsense', en: 'nonsense' });
		expect(isQuoteStatus('nonsense')).toBe(false);
	});
});

// S403 — operator REFUSE-with-reason surfaces the reason on the portal.
// `rejected` is reused as the storefront status; the reason rides the
// transition notes.
describe('quote-status — refusal reason extraction (S403)', () => {
	it('returns the note of the most recent transition into `rejected`', () => {
		const history = [
			{ at: '1', from: 'received', to: 'quoting', notes: '' },
			{ at: '2', from: 'quoting', to: 'quoted', notes: '' },
			{ at: '3', from: 'processing', to: 'rejected', notes: 'Out of stock — no 6061-T6.' }
		];
		expect(extractRefusalReason(history)).toBe('Out of stock — no 6061-T6.');
	});

	it('returns null when there is no rejected transition or it carried no note', () => {
		expect(extractRefusalReason(undefined)).toBeNull();
		expect(extractRefusalReason(null)).toBeNull();
		expect(extractRefusalReason([])).toBeNull();
		expect(
			extractRefusalReason([{ to: 'rejected', notes: '   ' }]),
			'whitespace-only note is treated as no reason'
		).toBeNull();
		expect(extractRefusalReason([{ to: 'processing', notes: 'not a refusal' }])).toBeNull();
	});

	it('picks the latest rejected note when there is more than one', () => {
		const history = [
			{ to: 'rejected', notes: 'first reason' },
			{ to: 'rejected', notes: 'final reason' }
		];
		expect(extractRefusalReason(history)).toBe('final reason');
	});

	it('truncates an over-long reason with an ellipsis but leaves short ones intact', () => {
		expect(truncateRefusalReason('short reason')).toBe('short reason');
		const long = 'x'.repeat(REFUSAL_REASON_DISPLAY_MAX + 50);
		const out = truncateRefusalReason(long);
		expect(out.length).toBeLessThanOrEqual(REFUSAL_REASON_DISPLAY_MAX + 1);
		expect(out.endsWith('…')).toBe(true);
	});
});
