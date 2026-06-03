import { extname } from 'node:path';

export type ValidationResult = { valid: true } | { valid: false; reason: string };

const OBJ_DIRECTIVE_RE = /(?:^|\n)\s*(?:v|vn|vt|vp|f|o|g|s|l|p|mtllib|usemtl)\s/;
const DXF_ASCII_RE = /^\s*0\s*[\r\n]+\s*SECTION\s*[\r\n]+\s*2\s*[\r\n]+\s*HEADER/;
const DXF_BINARY_MAGIC = 'AutoCAD Binary DXF\r\n\x1a\x00';
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_FILE_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PARASOLID_TEXT_HEADER = '**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**';
const DWG_VERSION_RE = /^AC10\d{2}$/;

/**
 * Identify common non-CAD payloads so the customer error message can explain
 * what we actually received (the [[hulye-biztos]] guidance — never just say
 * "rejected", always say what we saw).
 */
function describeBuffer(buf: Buffer): string {
	if (buf.length === 0) return 'an empty file';
	if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
		return 'a PDF document';
	}
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
		return 'a PNG image';
	}
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
		return 'a JPEG image';
	}
	if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF87a') {
		return 'a GIF image';
	}
	if (buf.length >= 6 && buf.subarray(0, 6).toString('ascii') === 'GIF89a') {
		return 'a GIF image';
	}
	if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
		return 'a ZIP-format file';
	}
	if (buf.length >= 8 && OLE_MAGIC.compare(buf.subarray(0, 8)) === 0) {
		return 'a Microsoft OLE Compound Document';
	}
	const peek = buf.subarray(0, Math.min(256, buf.length));
	if (isMostlyPrintable(peek)) {
		const firstLine = peek
			.toString('utf8')
			.split(/[\r\n]/)[0]
			.trim()
			.slice(0, 60);
		if (firstLine.length > 0) return `text starting with \`${firstLine}\``;
		return 'whitespace-only text';
	}
	const hex = Array.from(buf.subarray(0, Math.min(8, buf.length)))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join(' ');
	return `binary data starting with bytes \`${hex}\``;
}

function isMostlyPrintable(buf: Buffer): boolean {
	if (buf.length === 0) return false;
	let printable = 0;
	for (const b of buf) {
		if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
			printable++;
		}
	}
	return printable / buf.length >= 0.95;
}

function asciiPeek(buf: Buffer, n: number): string {
	return buf.subarray(0, Math.min(n, buf.length)).toString('latin1');
}

function fail(reason: string): ValidationResult {
	return { valid: false, reason };
}

const ok: ValidationResult = { valid: true };

export function validateSTEP(buf: Buffer): ValidationResult {
	const head = asciiPeek(buf, 4096).replace(/^[\s]+/, '');
	if (!head.startsWith('ISO-10303-21;')) {
		return fail(
			`Expected STEP header \`ISO-10303-21;\` but file looks like ${describeBuffer(buf)}.`
		);
	}
	if (!/[\r\n]\s*HEADER\s*;/.test(head)) {
		return fail(
			'STEP file has the `ISO-10303-21;` prologue but is missing the `HEADER;` block — the file is malformed or truncated.'
		);
	}
	return ok;
}

export function validateIGES(buf: Buffer): ValidationResult {
	const head = asciiPeek(buf, 8192);
	const lines = head.split(/\r?\n/).filter((l) => l.length > 0);
	if (lines.length === 0) {
		return fail(`Expected IGES section markers but file looks like ${describeBuffer(buf)}.`);
	}
	// IGES is column-strict: every line is 80 chars wide and column 73 (1-indexed)
	// carries the section letter (S/G/D/P/T). The first line should be a Start
	// section ('S') record. We accept either a strict 80-col first line or a
	// looser check (some exporters trim trailing whitespace).
	const first = lines[0];
	const col72 = first.length >= 73 ? first.charAt(72) : '';
	const looseMarker = first.match(/([SGDPT])\s*\d+\s*$/);
	const marker = col72 || (looseMarker ? looseMarker[1] : '');
	if (marker !== 'S') {
		return fail(
			`Expected IGES Start-section marker \`S\` in column 73 but file looks like ${describeBuffer(buf)}.`
		);
	}
	// Verify at least one Global ('G') marker also appears — otherwise this is
	// likely a coincidental 'S' in some other text format.
	const hasGlobal = lines.some((l) => {
		if (l.length >= 73) return l.charAt(72) === 'G';
		return /G\s*\d+\s*$/.test(l);
	});
	if (!hasGlobal) {
		return fail(
			'IGES file has a Start-section marker but no Global-section (`G`) marker — the file is malformed or truncated.'
		);
	}
	return ok;
}

export function validateSTL(buf: Buffer): ValidationResult {
	if (buf.length < 15) {
		return fail(`STL file is too small (${buf.length} bytes) to contain even a single triangle.`);
	}
	const head = asciiPeek(buf, Math.min(512, buf.length)).trimStart();
	const looksAscii = /^solid\b/i.test(head);
	if (looksAscii) {
		// ASCII STL: `solid <name>` ... `endsolid <name>`. We accept the file as
		// ASCII iff `endsolid` appears in the buffer AND the leading prefix
		// scans as mostly-printable. Some binary STLs start with the literal
		// word `solid` but contain non-printable bytes shortly after — we
		// catch that here and fall through to the binary check.
		const sample = buf.subarray(0, Math.min(2048, buf.length));
		if (isMostlyPrintable(sample)) {
			const text = buf.toString('latin1');
			if (/\bendsolid\b/i.test(text) || /\bfacet\s+normal\b/i.test(text)) {
				return ok;
			}
		}
	}
	// Binary STL layout: 80-byte header + uint32 LE triangle count + N * 50 bytes.
	if (buf.length < 84) {
		return fail(
			`STL file is too small (${buf.length} bytes) for a binary STL — needs at least 84 bytes.`
		);
	}
	const triangleCount = buf.readUInt32LE(80);
	const expected = 84 + triangleCount * 50;
	if (buf.length !== expected) {
		// Sanity-cap the triangle count we mention in the message — for a
		// totally unrelated file the uint32 at offset 80 is junk and can be huge.
		const safeCount = triangleCount > 1_000_000_000 ? '(garbage)' : String(triangleCount);
		return fail(
			`STL file does not match either format: it has neither an ASCII \`solid…endsolid\` body nor a valid binary layout (header claims ${safeCount} triangles → expected ${expected} bytes, got ${buf.length}). File looks like ${describeBuffer(buf)}.`
		);
	}
	return ok;
}

export function validateParasolidText(buf: Buffer): ValidationResult {
	const head = asciiPeek(buf, PARASOLID_TEXT_HEADER.length + 16).trimStart();
	if (!head.startsWith(PARASOLID_TEXT_HEADER)) {
		return fail(
			`Expected Parasolid text header \`**A…z**\` but file looks like ${describeBuffer(buf)}.`
		);
	}
	return ok;
}

export function validateParasolidBinary(buf: Buffer): ValidationResult {
	// Real Parasolid binary files (.x_b) begin with a short ASCII preamble —
	// the same `**A…z**` envelope as .x_t — followed by an `SCH_` schema tag
	// and binary payload. Acceptance: the printable preamble must be present.
	const head = asciiPeek(buf, 256);
	const trimmed = head.replace(/^[\s]+/, '');
	if (
		!trimmed.startsWith(PARASOLID_TEXT_HEADER) &&
		!trimmed.startsWith('PS3') &&
		!trimmed.startsWith('**PARASOLID')
	) {
		return fail(
			`Expected Parasolid binary header (\`**A…z**\` or \`PS3\` magic) but file looks like ${describeBuffer(buf)}.`
		);
	}
	return ok;
}

export function validateOLE(buf: Buffer): ValidationResult {
	if (buf.length < 8 || OLE_MAGIC.compare(buf.subarray(0, 8)) !== 0) {
		return fail(
			`Expected OLE Compound Document magic \`D0 CF 11 E0 A1 B1 1A E1\` but file looks like ${describeBuffer(buf)}.`
		);
	}
	return ok;
}

function isZip(buf: Buffer): boolean {
	return buf.length >= 4 && ZIP_LOCAL_FILE_MAGIC.compare(buf.subarray(0, 4)) === 0;
}

/**
 * Verify zip-packaged CAD formats. `requiredEntries` is a list of filename
 * substrings; the buffer must contain ALL of them. We scan for the literal
 * bytes because the entry name appears verbatim in each local-file-header,
 * which is cheaper than fully decoding the central directory.
 */
export function validateZipArchive(
	buf: Buffer,
	requiredEntries: string[],
	formatLabel: string
): ValidationResult {
	if (!isZip(buf)) {
		return fail(
			`Expected ${formatLabel} (ZIP archive starting with \`PK\\x03\\x04\`) but file looks like ${describeBuffer(buf)}.`
		);
	}
	const missing = requiredEntries.filter((entry) => buf.indexOf(Buffer.from(entry)) === -1);
	if (missing.length > 0) {
		return fail(
			`File is a ZIP archive but does not look like a ${formatLabel}: missing entry \`${missing[0]}\`.`
		);
	}
	return ok;
}

export function validateDXF(buf: Buffer): ValidationResult {
	if (buf.length >= DXF_BINARY_MAGIC.length) {
		const head = buf.subarray(0, DXF_BINARY_MAGIC.length).toString('latin1');
		if (head === DXF_BINARY_MAGIC) return ok;
	}
	const ascii = asciiPeek(buf, 1024);
	if (DXF_ASCII_RE.test(ascii)) return ok;
	return fail(
		`Expected DXF group-code/HEADER section or binary DXF magic but file looks like ${describeBuffer(buf)}.`
	);
}

export function validateDWG(buf: Buffer): ValidationResult {
	if (buf.length < 6) {
		return fail(`File too short to be a DWG (got ${buf.length} bytes).`);
	}
	const version = buf.subarray(0, 6).toString('ascii');
	if (!DWG_VERSION_RE.test(version)) {
		return fail(
			`Expected DWG version magic \`AC10NN\` (e.g. AC1027 for AutoCAD 2013) but file looks like ${describeBuffer(buf)}.`
		);
	}
	return ok;
}

export function validateOBJ(buf: Buffer): ValidationResult {
	const sample = buf.subarray(0, Math.min(8192, buf.length));
	if (!isMostlyPrintable(sample)) {
		return fail(
			`Expected ASCII OBJ directives (\`v\`, \`f\`, \`vn\`, …) but file looks like ${describeBuffer(buf)}.`
		);
	}
	const text = sample.toString('utf8');
	if (!OBJ_DIRECTIVE_RE.test('\n' + text)) {
		return fail(
			`Expected OBJ vertex/face directives (\`v\`, \`f\`, \`vn\`, …) but found none in the first 8 KB.`
		);
	}
	return ok;
}

/** Dispatch: pick a validator from the filename's extension. */
export function validateCadFile(filename: string, buf: Buffer): ValidationResult {
	if (buf.length === 0) {
		return fail('File is empty.');
	}
	const ext = extname(filename).toLowerCase();
	switch (ext) {
		case '.step':
		case '.stp':
			return validateSTEP(buf);
		case '.iges':
		case '.igs':
			return validateIGES(buf);
		case '.stl':
			return validateSTL(buf);
		case '.x_t':
			return validateParasolidText(buf);
		case '.x_b':
			return validateParasolidBinary(buf);
		case '.sldprt':
		case '.ipt':
			return validateOLE(buf);
		case '.3mf':
			return validateZipArchive(buf, ['3D/3dmodel.model'], '3MF');
		case '.f3d':
			// Fusion 360 archives bundle a `manifest` plus per-component .smt files.
			// Different exporters use different inner layouts (Fusion vs. Inventor
			// vs. third-party); the one entry that's consistent across versions
			// is the top-level `manifest`. We don't enforce `Project.json` because
			// older Fusion exports omit it.
			return validateZipArchive(buf, ['manifest'], 'Fusion 360 archive');
		case '.dxf':
			return validateDXF(buf);
		case '.dwg':
			return validateDWG(buf);
		case '.obj':
			return validateOBJ(buf);
		default:
			return fail(`Unsupported CAD extension \`${ext}\`.`);
	}
}
