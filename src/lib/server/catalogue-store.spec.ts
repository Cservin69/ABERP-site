import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ES module imports are hoisted above any top-level statements, so we MUST set
// the env var before the store module is evaluated. Doing it inline at the top
// works only because we use dynamic import() inside the tests below — a static
// `import { … } from './catalogue-store'` would capture the default path
// (./data/catalogue, which would leak into the repo).
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-catalogue-'));
process.env.ABERP_SITE_CATALOGUE_DIR = TMP_ROOT;

type StoreModule = typeof import('./catalogue-store');

async function loadStore(): Promise<StoreModule> {
	return await import('./catalogue-store');
}

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const goodRow = () => ({
	grade: 'AL_6061_T6',
	display_name: 'Aluminium 6061-T6',
	stock_status: 'in_stock' as const,
	lead_time_default_days: 0
});

describe('validateMaterialRow', () => {
	it('accepts a well-formed row', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow(goodRow(), 0);
		expect(v.ok).toBe(true);
	});

	it('rejects a non-object', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow('AL_6061_T6', 0);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toMatch(/object/);
	});

	it('rejects missing grade', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), grade: '' }, 0);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toMatch(/grade/);
	});

	// S338 — real-world material grades are the push source (ABERP's
	// `quoting_materials.grade` PK). The pre-S338 regex rejected digit-first,
	// hyphenated, spaced and lowercase grades, which 400'd the entire push and
	// left `/quote` on the generic fallback. These now ACCEPT the shapes real
	// grades take.
	it('s338: accepts real-world ABERP seed grades', async () => {
		const { validateMaterialRow } = await loadStore();
		for (const grade of [
			'6061-T6',
			'7075-T651',
			'304',
			'316',
			'Ti-6Al-4V',
			'Inconel 718',
			'17-4PH',
			'PEEK'
		]) {
			const v = validateMaterialRow({ ...goodRow(), grade }, 0);
			expect(v.ok, `grade ${grade} must be accepted`).toBe(true);
		}
	});

	it('s338: still rejects a grade with a leading separator', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), grade: '-6061' }, 0);
		expect(v.ok).toBe(false);
	});

	it('s338: still rejects control-char / injection chars in grade', async () => {
		const { validateMaterialRow } = await loadStore();
		for (const grade of ['AL\r\n6061', 'AL\x006061', 'AL<script>', 'AL;DROP']) {
			const v = validateMaterialRow({ ...goodRow(), grade }, 0);
			expect(v.ok, `grade ${JSON.stringify(grade)} must be rejected`).toBe(false);
		}
	});

	it('rejects grade > 64 chars', async () => {
		const { validateMaterialRow } = await loadStore();
		const long = 'A' + 'B'.repeat(64);
		const v = validateMaterialRow({ ...goodRow(), grade: long }, 0);
		expect(v.ok).toBe(false);
	});

	it('rejects header-injection in display_name', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow(
			{ ...goodRow(), display_name: 'Aluminium\r\nBcc: attacker@example.com' },
			0
		);
		expect(v.ok).toBe(false);
	});

	it('rejects empty display_name', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), display_name: '   ' }, 0);
		expect(v.ok).toBe(false);
	});

	it('rejects unknown stock_status', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), stock_status: 'wishful' }, 0);
		expect(v.ok).toBe(false);
	});

	it('rejects negative lead_time_default_days', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), lead_time_default_days: -1 }, 0);
		expect(v.ok).toBe(false);
	});

	it('rejects lead_time_default_days > 365', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), lead_time_default_days: 366 }, 0);
		expect(v.ok).toBe(false);
	});

	it('rejects non-integer lead_time_default_days', async () => {
		const { validateMaterialRow } = await loadStore();
		const v = validateMaterialRow({ ...goodRow(), lead_time_default_days: 1.5 }, 0);
		expect(v.ok).toBe(false);
	});

	it('accepts every documented stock_status value', async () => {
		const { validateMaterialRow } = await loadStore();
		for (const s of [
			'in_stock',
			'source_1_2d',
			'source_3_7d',
			'source_2_4w',
			'special_order'
		] as const) {
			const v = validateMaterialRow({ ...goodRow(), stock_status: s }, 0);
			expect(v.ok).toBe(true);
		}
	});
});

describe('validateSnapshotBody', () => {
	it('accepts empty materials array', async () => {
		const { validateSnapshotBody } = await loadStore();
		const v = validateSnapshotBody({ materials: [] });
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.materials).toHaveLength(0);
	});

	it('rejects missing materials array', async () => {
		const { validateSnapshotBody } = await loadStore();
		const v = validateSnapshotBody({});
		expect(v.ok).toBe(false);
	});

	it('rejects non-object body', async () => {
		const { validateSnapshotBody } = await loadStore();
		const v = validateSnapshotBody('hello');
		expect(v.ok).toBe(false);
	});

	it('one bad row rejects the entire snapshot with a row index in the reason', async () => {
		const { validateSnapshotBody } = await loadStore();
		const v = validateSnapshotBody({
			materials: [goodRow(), { ...goodRow(), grade: 'TI_6AL_4V' }, { ...goodRow(), grade: 'oops!' }]
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toMatch(/materials\[2\]/);
	});

	it('rejects duplicate grades', async () => {
		const { validateSnapshotBody } = await loadStore();
		const v = validateSnapshotBody({ materials: [goodRow(), goodRow()] });
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toMatch(/duplicate/);
	});
});

describe('readCatalogueSnapshot / writeCatalogueAtomic round-trip', () => {
	beforeEach(async () => {
		const { unlink } = await import('node:fs/promises');
		try {
			await unlink(resolve(TMP_ROOT, 'materials.json'));
		} catch {
			/* ignore: file absent is the desired starting state */
		}
	});

	it('returns null when no snapshot has been written', async () => {
		const { readCatalogueSnapshot } = await loadStore();
		const snap = await readCatalogueSnapshot();
		expect(snap).toBeNull();
	});

	it('writes and reads back identical materials', async () => {
		const { writeCatalogueAtomic, readCatalogueSnapshot } = await loadStore();
		const materials = [
			goodRow(),
			{
				grade: 'TI_6AL_4V',
				display_name: 'Titanium Ti-6Al-4V',
				stock_status: 'source_1_2d' as const,
				lead_time_default_days: 2
			}
		];
		await writeCatalogueAtomic({ materials, received_at: '2026-06-06T12:00:00Z' });
		const snap = await readCatalogueSnapshot();
		expect(snap).not.toBeNull();
		expect(snap?.materials).toEqual(materials);
		expect(snap?.received_at).toBe('2026-06-06T12:00:00Z');
	});

	it('currentCatalogueGrades returns the set of grades, empty when cold', async () => {
		const { currentCatalogueGrades, writeCatalogueAtomic } = await loadStore();
		expect((await currentCatalogueGrades()).size).toBe(0);
		await writeCatalogueAtomic({
			materials: [goodRow(), { ...goodRow(), grade: 'TI_6AL_4V' }],
			received_at: '2026-06-06T12:00:00Z'
		});
		const grades = await currentCatalogueGrades();
		expect(grades.has('AL_6061_T6')).toBe(true);
		expect(grades.has('TI_6AL_4V')).toBe(true);
		expect(grades.has('UNKNOWN')).toBe(false);
	});
});
