import { describe, it, expect } from 'vitest';
import {
	buildMaterialOptions,
	filterMaterialOptions,
	labelForValue,
	FALLBACK_OPTIONS,
	UNKNOWN_OPTION,
	OTHER_OPTION,
	MIN_FILTER_CHARS,
	type CatalogueMaterial
} from './material-options';

const CATALOGUE: CatalogueMaterial[] = [
	{
		grade: 'AL_6061_T6',
		display_name: 'Aluminium 6061-T6',
		stock_status: 'in_stock',
		lead_time_default_days: 0
	},
	{
		grade: 'AL_7075_T651',
		display_name: 'Aluminium 7075-T651',
		stock_status: 'in_stock',
		lead_time_default_days: 3
	},
	{
		grade: 'SS_304',
		display_name: 'Stainless steel 304',
		stock_status: 'in_stock',
		lead_time_default_days: 0
	},
	{
		grade: 'SS_316',
		display_name: 'Stainless steel 316',
		stock_status: 'in_stock',
		lead_time_default_days: 0
	},
	{
		grade: 'TI_6AL4V',
		display_name: 'Titanium Ti-6Al-4V',
		stock_status: 'order',
		lead_time_default_days: 14
	}
];

describe('buildMaterialOptions', () => {
	it('returns the fallback inventory (plus bookends) when the catalogue is cold', () => {
		const opts = buildMaterialOptions([]);
		const values = opts.map((o) => o.value).sort();
		expect(values).toEqual(['unknown', 'other', ...FALLBACK_OPTIONS.map((o) => o.value)].sort());
	});

	it('uses live catalogue grades when present and drops the fallback', () => {
		const opts = buildMaterialOptions(CATALOGUE);
		const values = opts.map((o) => o.value);
		expect(values).toContain('AL_6061_T6');
		expect(values).toContain('SS_316');
		// fallback generic keys must NOT leak in once the catalogue is warm
		expect(values).not.toContain('aluminum');
		expect(values).not.toContain('stainless');
	});

	it('always includes the unknown + other bookends', () => {
		const opts = buildMaterialOptions(CATALOGUE);
		expect(opts).toContainEqual(UNKNOWN_OPTION);
		expect(opts).toContainEqual(OTHER_OPTION);
	});

	it('sorts the whole list alphabetically by label (bookends inline)', () => {
		const labels = buildMaterialOptions(CATALOGUE).map((o) => o.label);
		expect(labels).toEqual([
			'Aluminium 6061-T6',
			'Aluminium 7075-T651',
			'Not sure / ask us',
			'Other (note below)',
			'Stainless steel 304',
			'Stainless steel 316',
			'Titanium Ti-6Al-4V'
		]);
	});

	it('loses no option versus the catalogue + 2 bookends', () => {
		expect(buildMaterialOptions(CATALOGUE)).toHaveLength(CATALOGUE.length + 2);
	});
});

describe('filterMaterialOptions ([[hulye-biztos]])', () => {
	const opts = buildMaterialOptions(CATALOGUE);

	it('shows the full list below the filter threshold', () => {
		expect(filterMaterialOptions(opts, '')).toEqual(opts);
		expect(filterMaterialOptions(opts, 'a')).toEqual(opts);
		expect(filterMaterialOptions(opts, 'al')).toHaveLength(opts.length);
		expect('al'.length).toBeLessThan(MIN_FILTER_CHARS);
	});

	it('"alu" surfaces only the aluminium grades', () => {
		const r = filterMaterialOptions(opts, 'alu').map((o) => o.label);
		expect(r).toEqual(['Aluminium 6061-T6', 'Aluminium 7075-T651']);
	});

	it('"stainless" surfaces only the stainless grades', () => {
		const r = filterMaterialOptions(opts, 'stainless').map((o) => o.label);
		expect(r).toEqual(['Stainless steel 304', 'Stainless steel 316']);
	});

	it('is case-insensitive and matches substrings anywhere in the label', () => {
		expect(filterMaterialOptions(opts, 'TITAN').map((o) => o.value)).toEqual(['TI_6AL4V']);
		expect(filterMaterialOptions(opts, '316').map((o) => o.value)).toEqual(['SS_316']);
	});

	it('trims whitespace before measuring the threshold', () => {
		expect(filterMaterialOptions(opts, '  a  ')).toEqual(opts);
		expect(filterMaterialOptions(opts, '  alu  ').map((o) => o.value)).toEqual([
			'AL_6061_T6',
			'AL_7075_T651'
		]);
	});

	it('returns an empty array when nothing matches', () => {
		expect(filterMaterialOptions(opts, 'xyzzy')).toEqual([]);
	});
});

describe('labelForValue', () => {
	const opts = buildMaterialOptions(CATALOGUE);

	it('renders unknown as an empty box (placeholder carries the text)', () => {
		expect(labelForValue(opts, 'unknown')).toBe('');
	});

	it('renders a real grade as its display label', () => {
		expect(labelForValue(opts, 'SS_316')).toBe('Stainless steel 316');
		expect(labelForValue(opts, 'other')).toBe('Other (note below)');
	});

	it('falls back to empty for an unrecognised value', () => {
		expect(labelForValue(opts, 'NOPE')).toBe('');
	});
});
