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

/**
 * STEP-only decision (operator call, 2026-08): the CAD pipeline no longer takes
 * mesh input, so `.stl` is retired. It is deliberately NOT just dropped from the
 * extension allowlist — that would yield the terse flat "File type not allowed"
 * 400. Instead the upload path keeps routing `.stl` (and anything that *sniffs*
 * as STL under some other extension) into this validator, so the customer gets
 * the structured `invalid_file` per-file chip that says what to upload instead.
 */
export const STL_RETIRED_REASON =
	'STL is no longer accepted — please upload STEP (.step/.stp). Mesh formats like STL lose the exact geometry our quoting engine needs.';

/**
 * The customer-facing line for every other non-STEP format (S204). STEP is the
 * only format the quoting pipeline actually processes today; everything else
 * used to upload cleanly and then dead-end as a Permanent failure, which is
 * worse than an honest reject at the door.
 */
export const STEP_ONLY_REASON =
	'We currently accept STEP only (.step / .stp). Please export or convert your CAD to STEP and re-upload.';

/**
 * Formats that were on the upload allowlist until S204 and are now rejected at
 * the door. The label is what the customer is told we saw. `.stl` is NOT in
 * here — it keeps its own, stronger message, because mesh can never become a
 * solid and is out permanently rather than just for now. Backlog D-18 (internal
 * OCCT normalize) is what re-broadens the SOLID entries here (IGES/BREP first).
 */
export const RETIRED_NON_STEP_EXT: Readonly<Record<string, string>> = {
	'.iges': 'IGES',
	'.igs': 'IGES',
	'.x_t': 'Parasolid text',
	'.x_b': 'Parasolid binary',
	'.sldprt': 'A SolidWorks part',
	'.ipt': 'An Inventor part',
	'.f3d': 'A Fusion 360 archive',
	'.dxf': 'DXF',
	'.dwg': 'DWG',
	'.3mf': '3MF',
	'.obj': 'OBJ'
};

function retiredExtReason(ext: string, label: string): string {
	return `${label} (\`${ext}\`) is not accepted. ${STEP_ONLY_REASON}`;
}

/**
 * Content-sniff the retired formats, most-specific magic first. Like
 * `looksLikeSTL` this carries no acceptance semantics: it is only ever
 * consulted after STEP validation has ALREADY failed, purely so a non-STEP
 * file renamed `.step`/`.stp` is told what it actually is instead of getting a
 * bare "expected ISO-10303-21". It can never turn a rejection into an
 * acceptance. OBJ is probed last because its directive check is the loosest.
 */
export function sniffRetiredFormat(buf: Buffer): string | null {
	const probes: [(b: Buffer) => ValidationResult, string][] = [
		[validateOLE, 'a SolidWorks/Inventor part'],
		[validateDWG, 'DWG'],
		[(b) => validateZipArchive(b, ['3D/3dmodel.model'], '3MF'), '3MF'],
		[(b) => validateZipArchive(b, ['manifest'], 'Fusion 360 archive'), 'a Fusion 360 archive'],
		[validateParasolidBinary, 'Parasolid'],
		[validateDXF, 'DXF'],
		[validateIGES, 'IGES'],
		[validateOBJ, 'OBJ']
	];
	for (const [probe, label] of probes) {
		if (probe(buf).valid) return label;
	}
	return null;
}

/**
 * Content-sniff an STL, both encodings. This carries no acceptance semantics: it
 * is only ever consulted for a buffer whose own extension validator has ALREADY
 * failed (e.g. an STL renamed to `.step`), purely to swap a confusing
 * format-specific message for the honest `STL_RETIRED_REASON`. It can never
 * turn a rejection into an acceptance.
 */
export function looksLikeSTL(buf: Buffer): boolean {
	if (buf.length < 15) return false;
	// ASCII STL: `solid <name>` … `facet normal` … `endsolid <name>`. The
	// facet/endsolid keyword is required because plenty of other text starts
	// with the word "solid". Sniffing the first 8 KB is enough — a real ASCII
	// STL emits its first facet a line or two after the header.
	const sample = buf.subarray(0, Math.min(8192, buf.length));
	if (isMostlyPrintable(sample)) {
		const text = sample.toString('latin1');
		if (
			/^\s*solid\b/i.test(text) &&
			(/\bfacet\s+normal\b/i.test(text) || /\bendsolid\b/i.test(text))
		) {
			return true;
		}
	}
	// Binary STL layout: 80-byte header + uint32 LE triangle count + N * 50 bytes.
	// The exact-length identity is what makes this a safe sniff — an unrelated
	// file matching it by coincidence is vanishingly unlikely.
	if (buf.length < 84) return false;
	const triangleCount = buf.readUInt32LE(80);
	return buf.length === 84 + triangleCount * 50;
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
	// Layer 1 (extension). STEP is the only accepted family; `.stl` and the
	// formats retired in S204 are rejected here with guidance, everything else
	// never gets this far (the flat allowlist in /api/quote catches it).
	if (ext === '.stl') {
		return fail(STL_RETIRED_REASON);
	}
	const retiredLabel = RETIRED_NON_STEP_EXT[ext];
	if (retiredLabel !== undefined) {
		return fail(retiredExtReason(ext, retiredLabel));
	}
	if (ext !== '.step' && ext !== '.stp') {
		return fail(`Unsupported CAD extension \`${ext}\`.`);
	}

	const result = validateSTEP(buf);
	if (result.valid) return result;
	// Layer 2 (content sniff): the file claims `.step`/`.stp` but is not STEP.
	// Re-label it with the honest retirement/STEP-only message so the customer
	// is told the real problem instead of "expected ISO-10303-21". Only ever
	// consulted on an existing failure, so it cannot accept anything.
	if (looksLikeSTL(buf)) {
		return fail(STL_RETIRED_REASON);
	}
	const sniffed = sniffRetiredFormat(buf);
	if (sniffed !== null) {
		return fail(`This file looks like ${sniffed}, not STEP. ${STEP_ONLY_REASON}`);
	}
	return result;
}
