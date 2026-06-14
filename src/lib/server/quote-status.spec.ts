import { describe, it, expect } from 'vitest';
import {
	QUOTE_STATUSES,
	QUOTE_STATUS_LABELS,
	isQuoteStatus,
	quoteStatusLabel
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
