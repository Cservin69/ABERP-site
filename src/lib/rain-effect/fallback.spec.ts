import { describe, it, expect } from 'vitest';
import { decideRainFallback } from './fallback.ts';

describe('decideRainFallback', () => {
	const base = { reducedMotion: false, saveData: false, innerWidth: 1280 };

	it('returns no-fallback on a healthy desktop env', () => {
		expect(decideRainFallback(base)).toEqual({ fallback: false });
	});

	it('falls back when the OS reports prefers-reduced-motion', () => {
		expect(decideRainFallback({ ...base, reducedMotion: true })).toEqual({
			fallback: true,
			reason: 'reduced-motion'
		});
	});

	it('falls back when the connection reports Save-Data', () => {
		expect(decideRainFallback({ ...base, saveData: true })).toEqual({
			fallback: true,
			reason: 'save-data'
		});
	});

	it('falls back on a tiny viewport (<480 CSS px)', () => {
		expect(decideRainFallback({ ...base, innerWidth: 390 })).toEqual({
			fallback: true,
			reason: 'tiny-viewport'
		});
	});

	it('reduced-motion wins over other reasons', () => {
		expect(decideRainFallback({ reducedMotion: true, saveData: true, innerWidth: 100 })).toEqual({
			fallback: true,
			reason: 'reduced-motion'
		});
	});

	it('keeps WebGL enabled exactly at the 480px threshold', () => {
		expect(decideRainFallback({ ...base, innerWidth: 480 })).toEqual({ fallback: false });
	});
});
