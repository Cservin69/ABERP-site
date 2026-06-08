import { describe, it, expect } from 'vitest';
import { verifyBodySizeLimit, EXPECTED_BODY_SIZE_LIMIT } from './body-size-limit';

describe('verifyBodySizeLimit', () => {
	it('flags an unset env var as the adapter-node-default 512 KB case', () => {
		const v = verifyBodySizeLimit(undefined);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe('unset');
		expect(v.message).toContain('adapter-node default 524288');
		expect(v.message).toContain('S285');
	});

	it('flags an empty env var (operator wiped EnvironmentFile value) as unset', () => {
		const v = verifyBodySizeLimit('');
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe('unset');
	});

	it('flags a value below the expected cap as too-low', () => {
		const v = verifyBodySizeLimit('6291456'); // 6 MB — the ADR-0004 priced cap
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toBe('too-low');
		// Naming both the 50 MB CAD cap and the 6 MB priced cap in the message
		// is intentional: it tells the operator which two endpoints will break
		// and what the right value is.
		expect(v.message).toContain('/api/quote');
		expect(v.message).toContain('/api/quotes/{id}/priced');
		expect(v.message).toContain(String(EXPECTED_BODY_SIZE_LIMIT));
	});

	it('flags a non-numeric value as too-low (NaN parse)', () => {
		const v = verifyBodySizeLimit('definitely-not-a-number');
		expect(v.ok).toBe(false);
		if (v.ok) return;
		// Non-numeric inputs surface as too-low because EnvironmentFile values
		// land here as strings; adapter-node would also throw on parse, but
		// our check runs first and gives the operator a clearer message.
		expect(v.reason).toBe('too-low');
	});

	it('passes when the value matches the expected cap exactly', () => {
		const v = verifyBodySizeLimit(String(EXPECTED_BODY_SIZE_LIMIT));
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.configured).toBe(EXPECTED_BODY_SIZE_LIMIT);
	});

	it('passes when the value exceeds the expected cap', () => {
		const v = verifyBodySizeLimit(String(EXPECTED_BODY_SIZE_LIMIT * 2));
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.configured).toBe(EXPECTED_BODY_SIZE_LIMIT * 2);
	});

	it('expected cap covers every in-handler body cap in this repo', () => {
		// Sanity: if any handler ships a body cap larger than 50 MB later,
		// EXPECTED_BODY_SIZE_LIMIT needs to be lifted too — otherwise the
		// adapter pre-empts the handler's check. /api/quote caps at 50 MB
		// (MAX_TOTAL_BYTES) and /api/quotes/{id}/priced at 6 MB (BODY_MAX_BYTES);
		// 50 MB is the binding constraint today.
		expect(EXPECTED_BODY_SIZE_LIMIT).toBeGreaterThanOrEqual(50 * 1024 * 1024);
	});
});
