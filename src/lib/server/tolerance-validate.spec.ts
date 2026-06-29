import { describe, it, expect } from 'vitest';
import { validateTolerance } from './tolerance-validate';
import { TOLERANCE_SCHEMES, TOLERANCE_DEFAULT, isToleranceScheme } from '$lib/tolerance';

describe('validateTolerance', () => {
	it('accepts every token in the closed vocabulary', () => {
		for (const scheme of TOLERANCE_SCHEMES) {
			expect(validateTolerance(scheme)).toEqual({ valid: true });
		}
	});

	it('accepts the default scheme', () => {
		expect(validateTolerance(TOLERANCE_DEFAULT)).toEqual({ valid: true });
	});

	it('rejects an out-of-vocabulary token, naming what we saw and the allowed set', () => {
		const r = validateTolerance('ultra_tight');
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason).toMatch(/general, precision, per_drawing/);
			expect(r.reason).toMatch(/ultra_tight/);
		}
	});

	it('rejects a raw IT-grade — exactly the garbage the closed set prevents', () => {
		const r = validateTolerance('IT7');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/IT7/);
	});

	it('rejects a free-form ± value', () => {
		const r = validateTolerance('+/-0.01');
		expect(r.valid).toBe(false);
	});

	it('rejects an empty string with a clear message (not a bare quote)', () => {
		const r = validateTolerance('');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/empty value/);
	});

	it('is case-sensitive: GENERAL is not general', () => {
		expect(validateTolerance('GENERAL').valid).toBe(false);
	});

	it('caps a hostile overlong value in the reason (bounded echo, no blowup)', () => {
		const r = validateTolerance('x'.repeat(5000));
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason.length).toBeLessThan(160);
			expect(r.reason).toMatch(/…/);
		}
	});

	it('isToleranceScheme guards the union', () => {
		expect(isToleranceScheme('general')).toBe(true);
		expect(isToleranceScheme('per_drawing')).toBe(true);
		expect(isToleranceScheme('nope')).toBe(false);
		expect(isToleranceScheme('')).toBe(false);
	});
});
