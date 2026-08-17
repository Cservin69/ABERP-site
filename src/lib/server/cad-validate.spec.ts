import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	validateCadFile,
	validateSTEP,
	validateIGES,
	looksLikeSTL,
	sniffRetiredFormat,
	STL_RETIRED_REASON,
	STEP_ONLY_REASON,
	RETIRED_NON_STEP_EXT,
	validateParasolidText,
	validateParasolidBinary,
	validateOLE,
	validateZipArchive,
	validateDXF,
	validateDWG,
	validateOBJ
} from './cad-validate';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', '..', '..', 'tests', 'fixtures', 'cad');
const read = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));

const PDF_BYTES = read('not-cad.pdf');
const PNG_BYTES = read('not-cad.png');
const TXT_BYTES = read('not-cad.txt');

describe('validateSTEP', () => {
	it('accepts a real STEP file', () => {
		expect(validateSTEP(read('valid.step'))).toEqual({ valid: true });
	});
	it('rejects a PDF with a friendly hint', () => {
		const r = validateSTEP(PDF_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason).toMatch(/ISO-10303-21/);
			expect(r.reason).toMatch(/PDF/);
		}
	});
	it('rejects a STEP-like prologue with no HEADER block', () => {
		const buf = Buffer.from('ISO-10303-21;\n\n');
		const r = validateSTEP(buf);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/HEADER/);
	});
});

describe('validateIGES', () => {
	it('accepts a real IGES file', () => {
		expect(validateIGES(read('valid.iges'))).toEqual({ valid: true });
	});
	it('rejects plain text', () => {
		const r = validateIGES(TXT_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/Start-section/);
	});
	it('rejects IGES with Start marker but no Global', () => {
		const padded = 'placeholder data'.padEnd(72, ' ') + 'S' + '      1';
		const r = validateIGES(Buffer.from(padded + '\n'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/Global/);
	});
});

describe('looksLikeSTL (STEP-only retirement sniff)', () => {
	it('sniffs a real ASCII STL', () => {
		expect(looksLikeSTL(read('valid_ascii.stl'))).toBe(true);
	});
	it('sniffs a real binary STL', () => {
		expect(looksLikeSTL(read('valid_binary.stl'))).toBe(true);
	});
	it('does not sniff a STEP file as STL', () => {
		expect(looksLikeSTL(read('valid.step'))).toBe(false);
	});
	it('does not sniff IGES / DXF fixtures as STL', () => {
		expect(looksLikeSTL(read('valid.iges'))).toBe(false);
		expect(looksLikeSTL(read('valid.dxf'))).toBe(false);
	});
	it('does not sniff non-CAD payloads as STL', () => {
		expect(looksLikeSTL(PDF_BYTES)).toBe(false);
		expect(looksLikeSTL(PNG_BYTES)).toBe(false);
		expect(looksLikeSTL(TXT_BYTES)).toBe(false);
	});
	it('does not sniff text that merely starts with the word "solid"', () => {
		expect(looksLikeSTL(Buffer.from('solid aluminium bar stock, 40 mm, please quote\n'))).toBe(
			false
		);
	});
	it('does not sniff a binary blob whose length misses the 84 + 50N layout', () => {
		// 84 bytes claiming 5 triangles → a real binary STL would be 334 bytes.
		const buf = Buffer.alloc(84);
		buf.writeUInt32LE(5, 80);
		expect(looksLikeSTL(buf)).toBe(false);
	});
	it('does not sniff an under-15-byte buffer', () => {
		expect(looksLikeSTL(Buffer.from('tiny'))).toBe(false);
	});
});

describe('validateParasolidText', () => {
	it('accepts the standard text header', () => {
		const buf = Buffer.from(
			'**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**\nrest of content'
		);
		expect(validateParasolidText(buf)).toEqual({ valid: true });
	});
	it('rejects plain text without the header', () => {
		const r = validateParasolidText(TXT_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/Parasolid text header/);
	});
});

describe('validateParasolidBinary', () => {
	it('accepts the standard alphabet header', () => {
		const buf = Buffer.concat([
			Buffer.from('**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**\n'),
			Buffer.from([0x00, 0x01, 0x02, 0x03])
		]);
		expect(validateParasolidBinary(buf)).toEqual({ valid: true });
	});
	it('accepts a PS3-magic header', () => {
		expect(validateParasolidBinary(Buffer.from('PS3binarypayload'))).toEqual({ valid: true });
	});
	it('rejects unrelated binary data', () => {
		const r = validateParasolidBinary(PNG_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/Parasolid binary header/);
	});
});

describe('validateOLE', () => {
	it('accepts the 8-byte OLE magic', () => {
		const buf = Buffer.concat([
			Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
			Buffer.alloc(16)
		]);
		expect(validateOLE(buf)).toEqual({ valid: true });
	});
	it('rejects a plain text buffer', () => {
		const r = validateOLE(TXT_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/OLE Compound Document magic/);
	});
});

describe('validateZipArchive', () => {
	it('accepts a zip-prefixed buffer containing the required entry', () => {
		const buf = Buffer.concat([
			Buffer.from([0x50, 0x4b, 0x03, 0x04]),
			Buffer.alloc(20, 0),
			Buffer.from('3D/3dmodel.model'),
			Buffer.alloc(8, 0)
		]);
		expect(validateZipArchive(buf, ['3D/3dmodel.model'], '3MF')).toEqual({ valid: true });
	});
	it('rejects a zip missing the required entry', () => {
		const buf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0)]);
		const r = validateZipArchive(buf, ['3D/3dmodel.model'], '3MF');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/missing entry/);
	});
	it('rejects a non-zip buffer', () => {
		const r = validateZipArchive(PDF_BYTES, ['3D/3dmodel.model'], '3MF');
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/ZIP archive/);
	});
});

describe('validateDXF', () => {
	it('accepts the ASCII DXF fixture', () => {
		expect(validateDXF(read('valid.dxf'))).toEqual({ valid: true });
	});
	it('accepts the binary DXF magic', () => {
		const buf = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00'), Buffer.alloc(16)]);
		expect(validateDXF(buf)).toEqual({ valid: true });
	});
	it('rejects a PNG', () => {
		const r = validateDXF(PNG_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/DXF/);
	});
});

describe('validateDWG', () => {
	it('accepts AC1027 (AutoCAD 2013)', () => {
		const buf = Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(16)]);
		expect(validateDWG(buf)).toEqual({ valid: true });
	});
	it('accepts AC1015 (AutoCAD 2000)', () => {
		const buf = Buffer.concat([Buffer.from('AC1015'), Buffer.alloc(16)]);
		expect(validateDWG(buf)).toEqual({ valid: true });
	});
	it('rejects buffers without a version magic', () => {
		const r = validateDWG(PDF_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/AC10NN/);
	});
});

describe('validateOBJ', () => {
	it('accepts a buffer with v/f directives', () => {
		const buf = Buffer.from('# PR-P fixture\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
		expect(validateOBJ(buf)).toEqual({ valid: true });
	});
	it('rejects a buffer with no directives', () => {
		const r = validateOBJ(Buffer.from('hello world, no obj content here\n'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/directives/);
	});
	it('rejects binary data', () => {
		const r = validateOBJ(PNG_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/directives/);
	});
});

describe('validateCadFile (dispatcher)', () => {
	it('refuses an empty buffer before format dispatch', () => {
		const r = validateCadFile('anything.step', Buffer.alloc(0));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/empty/i);
	});

	it('routes by extension — .stp uses STEP validator', () => {
		expect(validateCadFile('part.stp', read('valid.step'))).toEqual({ valid: true });
	});

	it('rejects a genuine IGES file — the pipeline is STEP-only', () => {
		const r = validateCadFile('part.igs', read('valid.iges'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toContain(STEP_ONLY_REASON);
	});

	it('rejects unknown extensions', () => {
		const r = validateCadFile('hax.exe', Buffer.from('MZ...'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/Unsupported/);
	});

	it('catches the Ervin taxi-receipt scenario: PDF posing as .step', () => {
		const r = validateCadFile('taxi.step', PDF_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) {
			// The message must explain *what* we saw, not just say "rejected".
			expect(r.reason).toMatch(/PDF/);
		}
	});

	it('catches a PNG posing as .stl', () => {
		const r = validateCadFile('photo.stl', PNG_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/PNG|STL/);
	});
});

describe('validateCadFile — STL retirement (STEP-only pipeline)', () => {
	it('rejects a genuine ASCII STL by extension', () => {
		const r = validateCadFile('cube.stl', read('valid_ascii.stl'));
		expect(r).toEqual({ valid: false, reason: STL_RETIRED_REASON });
	});

	it('rejects a genuine binary STL by extension', () => {
		const r = validateCadFile('cube.stl', read('valid_binary.stl'));
		expect(r).toEqual({ valid: false, reason: STL_RETIRED_REASON });
	});

	it('rejects `.STL` case-insensitively', () => {
		const r = validateCadFile('CUBE.STL', read('valid_binary.stl'));
		expect(r).toEqual({ valid: false, reason: STL_RETIRED_REASON });
	});

	it('rejects an ASCII STL renamed to .step via the content sniff', () => {
		const r = validateCadFile('cube.step', read('valid_ascii.stl'));
		expect(r).toEqual({ valid: false, reason: STL_RETIRED_REASON });
	});

	it('rejects a binary STL renamed to .stp via the content sniff', () => {
		const r = validateCadFile('cube.stp', read('valid_binary.stl'));
		expect(r).toEqual({ valid: false, reason: STL_RETIRED_REASON });
	});

	it('rejects an STL renamed to .obj / .dxf', () => {
		// Both extensions are themselves retired now (S204), so the extension
		// gate answers first — the customer still gets STEP-only guidance.
		for (const name of ['cube.obj', 'cube.dxf']) {
			const r = validateCadFile(name, read('valid_ascii.stl'));
			expect(r.valid).toBe(false);
			if (!r.valid) expect(r.reason).toContain(STEP_ONLY_REASON);
		}
	});

	it('names STEP as the replacement in the customer-facing message', () => {
		expect(STL_RETIRED_REASON).toMatch(/no longer accepted/i);
		expect(STL_RETIRED_REASON).toMatch(/\.step/);
	});

	it('still accepts a real STEP file (the retirement did not break STEP)', () => {
		expect(validateCadFile('part.step', read('valid.step'))).toEqual({ valid: true });
		expect(validateCadFile('part.stp', read('valid.step'))).toEqual({ valid: true });
	});

	it('keeps the format-specific message for a non-STL mismatch', () => {
		// The sniff must not swallow other diagnostics: a PDF named .step still
		// gets the "expected ISO-10303-21 / looks like a PDF" explanation.
		const r = validateCadFile('taxi.step', PDF_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason).toMatch(/ISO-10303-21/);
			expect(r.reason).not.toBe(STL_RETIRED_REASON);
		}
	});
});

describe('validateCadFile — S204 STEP-only narrowing', () => {
	// Every extension that was on the allowlist before S204 and is now retired.
	const RETIRED = [
		'.iges',
		'.igs',
		'.x_t',
		'.x_b',
		'.sldprt',
		'.ipt',
		'.f3d',
		'.dxf',
		'.dwg',
		'.3mf',
		'.obj'
	];

	it('rejects every retired extension by extension alone', () => {
		for (const ext of RETIRED) {
			const r = validateCadFile(`part${ext}`, Buffer.from('anything at all, plausible or not'));
			expect(r, ext).toMatchObject({ valid: false });
			if (!r.valid) {
				expect(r.reason, ext).toContain(STEP_ONLY_REASON);
				expect(r.reason, ext).toContain(ext);
			}
		}
	});

	it('rejects a retired extension even when the payload is a genuine file of that format', () => {
		// The point of S204: a *valid* IGES/DXF is still rejected, because the
		// pipeline cannot quote it — better an honest 400 than a Permanent
		// failure after the customer has waited.
		for (const [name, buf] of [
			['part.iges', read('valid.iges')],
			['plate.dxf', read('valid.dxf')]
		] as const) {
			const r = validateCadFile(name, buf);
			expect(r.valid, name).toBe(false);
			if (!r.valid) expect(r.reason, name).toContain(STEP_ONLY_REASON);
		}
	});

	it('rejects retired extensions case-insensitively', () => {
		const r = validateCadFile('PART.IGES', read('valid.iges'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toContain(STEP_ONLY_REASON);
	});

	it('catches an IGES renamed to .step by content sniff', () => {
		const r = validateCadFile('sneaky.step', read('valid.iges'));
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason).toMatch(/looks like IGES, not STEP/);
			expect(r.reason).toContain(STEP_ONLY_REASON);
		}
	});

	it('catches a DXF renamed to .stp by content sniff', () => {
		const r = validateCadFile('sneaky.stp', read('valid.dxf'));
		expect(r.valid).toBe(false);
		if (!r.valid) {
			expect(r.reason).toMatch(/looks like DXF, not STEP/);
			expect(r.reason).toContain(STEP_ONLY_REASON);
		}
	});

	it('catches an OBJ, a DWG, an OLE part and a 3MF renamed to .step', () => {
		const cases: [string, Buffer, RegExp][] = [
			['mesh.step', Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), /looks like OBJ/],
			['draw.step', Buffer.concat([Buffer.from('AC1027'), Buffer.alloc(16)]), /looks like DWG/],
			[
				'part.step',
				Buffer.concat([
					Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
					Buffer.alloc(16)
				]),
				/looks like a SolidWorks\/Inventor part/
			],
			[
				'mesh3.step',
				Buffer.concat([
					Buffer.from([0x50, 0x4b, 0x03, 0x04]),
					Buffer.alloc(20, 0),
					Buffer.from('3D/3dmodel.model'),
					Buffer.alloc(8, 0)
				]),
				/looks like 3MF/
			]
		];
		for (const [name, buf, expected] of cases) {
			const r = validateCadFile(name, buf);
			expect(r.valid, name).toBe(false);
			if (!r.valid) {
				expect(r.reason, name).toMatch(expected);
				expect(r.reason, name).toContain(STEP_ONLY_REASON);
			}
		}
	});

	it('sniffRetiredFormat never claims a real STEP file', () => {
		expect(sniffRetiredFormat(read('valid.step'))).toBeNull();
	});

	it('sniffRetiredFormat does not mislabel non-CAD payloads', () => {
		expect(sniffRetiredFormat(PDF_BYTES)).toBeNull();
		expect(sniffRetiredFormat(PNG_BYTES)).toBeNull();
		expect(sniffRetiredFormat(TXT_BYTES)).toBeNull();
	});

	it('the customer-facing line names STEP and both accepted extensions', () => {
		expect(STEP_ONLY_REASON).toMatch(/STEP only/i);
		expect(STEP_ONLY_REASON).toContain('.step');
		expect(STEP_ONLY_REASON).toContain('.stp');
	});

	it('the retired-extension map covers exactly the formats dropped in S204', () => {
		expect(Object.keys(RETIRED_NON_STEP_EXT).sort()).toEqual([...RETIRED].sort());
		// Mesh is out permanently, STEP is in — neither may drift into the map.
		expect(RETIRED_NON_STEP_EXT['.step']).toBeUndefined();
		expect(RETIRED_NON_STEP_EXT['.stl']).toBeUndefined();
	});
});
