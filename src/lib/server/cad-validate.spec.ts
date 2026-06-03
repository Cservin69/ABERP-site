import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
	validateCadFile,
	validateSTEP,
	validateIGES,
	validateSTL,
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

describe('validateSTL', () => {
	it('accepts a real ASCII STL', () => {
		expect(validateSTL(read('valid_ascii.stl'))).toEqual({ valid: true });
	});
	it('accepts a real binary STL', () => {
		expect(validateSTL(read('valid_binary.stl'))).toEqual({ valid: true });
	});
	it('rejects a PDF with a friendly hint', () => {
		const r = validateSTL(PDF_BYTES);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/STL/);
	});
	it('rejects binary STL with mismatched triangle count', () => {
		// 84 bytes claim 5 triangles but no body present → expected 334, got 84.
		const buf = Buffer.alloc(84);
		buf.writeUInt32LE(5, 80);
		const r = validateSTL(buf);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/triangles/);
	});
	it('rejects an under-15-byte buffer', () => {
		const r = validateSTL(Buffer.from('tiny'));
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/too small/);
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

	it('routes by extension — .igs uses IGES validator', () => {
		expect(validateCadFile('part.igs', read('valid.iges'))).toEqual({ valid: true });
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
