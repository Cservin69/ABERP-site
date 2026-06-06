import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve, join, basename, extname } from 'node:path';
import type { QuoteMetadata } from '$lib/server/quote-store';
import { sendQuoteNotifications } from '$lib/server/email';
import { validateCadFile } from '$lib/server/cad-validate';
import { assertSameOrigin } from '$lib/server/origin-check';
import { currentCatalogueGrades } from '$lib/server/catalogue-store';

const QUOTE_DIR = process.env.ABERP_SITE_QUOTE_DIR ?? './data/quotes';
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FIELD_LEN = 4096;
const NOTES_MAX = 2000;
const ALLOWED_EXT = new Set([
	'.step',
	'.stp',
	'.iges',
	'.igs',
	'.stl',
	'.x_t',
	'.x_b',
	'.sldprt',
	'.ipt',
	'.f3d',
	'.dxf',
	'.dwg',
	'.3mf',
	'.obj'
]);
// Legacy free-text preferences accepted forever, so any pre-PR-02 tab still
// submits cleanly (the existing dropdown emits these values). Per ADR-0003,
// the catalogue grade set is unioned on top at validation time.
const LEGACY_MATERIAL_PREFERENCES = new Set([
	'unknown',
	'aluminum',
	'steel',
	'stainless',
	'brass',
	'plastic',
	'other'
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex -- intentional: reject CR/LF/NUL injection in submitted strings
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bad(message: string): Response {
	return json({ error: message }, { status: 400 });
}

function getField(form: FormData, name: string): string | null {
	const v = form.get(name);
	if (v === null) return null;
	if (typeof v !== 'string') return null;
	return v;
}

function sanitizeFilename(raw: string): string {
	const base = basename(raw).replace(/\\/g, '').trim();
	const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
	const trimmed = cleaned.replace(/^\.+/, '').slice(0, 200);
	return trimmed || 'unnamed';
}

export const POST: RequestHandler = async ({ request }) => {
	// PR-Q layer: explicit Origin allowlist on top of SvelteKit's csrf.checkOrigin.
	// Returns a structured JSON 403 the form's fetch().json() can parse, instead
	// of the framework's terse text body. See src/lib/server/origin-check.ts.
	const originReject = assertSameOrigin(request);
	if (originReject) return originReject;

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return bad('Invalid form data.');
	}

	// Honeypot: a hidden `website` field on the form. Real users never see it
	// (CSS-hidden, tabindex=-1, aria-hidden). Bots that auto-fill every input
	// will populate it. Silently 200-OK without writing anything so the bot
	// thinks the submission succeeded but we never persist or notify.
	const honeypot = getField(form, 'website');
	if (honeypot !== null && honeypot.trim().length > 0) {
		return json({ id: randomUUID(), status: 'received' });
	}

	const name = getField(form, 'name');
	const email = getField(form, 'email');
	const company = getField(form, 'company') ?? '';
	const material = getField(form, 'material') ?? 'unknown';
	const quantityRaw = getField(form, 'quantity');
	const deadline = getField(form, 'deadline') ?? '';
	const notes = getField(form, 'notes') ?? '';
	const consent = getField(form, 'consent');

	if (!name || name.trim().length === 0) return bad('Name is required.');
	if (!email || email.trim().length === 0) return bad('Email is required.');
	if (consent !== 'true') return bad('Consent is required.');

	const nameTrim = name.trim();
	const emailTrim = email.trim();
	const companyTrim = company.trim();
	const notesTrim = notes.trim();

	if (nameTrim.length > 200) return bad('Name too long.');
	if (emailTrim.length > 254) return bad('Email too long.');
	if (companyTrim.length > 200) return bad('Company name too long.');
	if (notesTrim.length > NOTES_MAX) return bad('Notes too long.');

	for (const [label, v] of [
		['name', nameTrim],
		['email', emailTrim],
		['company', companyTrim],
		['material', material],
		['deadline', deadline],
		['notes', notesTrim]
	] as const) {
		if (v.length > MAX_FIELD_LEN) return bad(`${label} too long.`);
		if (HEADER_INJECTION_RE.test(v)) return bad(`${label} contains invalid characters.`);
	}

	if (!EMAIL_RE.test(emailTrim)) return bad('Email is not valid.');

	// Material widening (PR-02 / ADR-0003): accept either a legacy preference
	// (the original closed enum) OR a grade in the current catalogue snapshot.
	// Grade values follow /^[A-Z][A-Z0-9_]*$/ and never collide with legacy
	// lowercase values, so the union is unambiguous.
	if (!LEGACY_MATERIAL_PREFERENCES.has(material)) {
		const grades = await currentCatalogueGrades();
		if (!grades.has(material)) return bad('Invalid material selection.');
	}

	let quantity: number | null = null;
	if (quantityRaw && quantityRaw.length > 0) {
		const n = Number.parseInt(quantityRaw, 10);
		if (!Number.isFinite(n) || n < 1 || n > 1_000_000) return bad('Invalid quantity.');
		quantity = n;
	}

	if (deadline && !DATE_RE.test(deadline)) return bad('Invalid deadline format.');

	const fileEntries = form.getAll('files').filter((v): v is File => v instanceof File);
	if (fileEntries.length === 0) return bad('At least one CAD file is required.');
	if (fileEntries.length > MAX_FILES) return bad(`Too many files (max ${MAX_FILES}).`);

	let totalBytes = 0;
	for (const f of fileEntries) {
		const ext = extname(f.name).toLowerCase();
		if (!ALLOWED_EXT.has(ext)) {
			return bad(`File type not allowed: ${f.name}`);
		}
		totalBytes += f.size;
		if (totalBytes > MAX_TOTAL_BYTES) {
			return bad('Total upload size exceeds 50 MB.');
		}
	}

	// Read each file once, run content-sniffing validation, hold the buffers
	// until persistence. The upload cap (MAX_TOTAL_BYTES = 50 MB) bounds memory.
	const loaded: { file: File; buf: Buffer }[] = [];
	const invalidFiles: { filename: string; reason: string }[] = [];
	for (const f of fileEntries) {
		const buf = Buffer.from(await f.arrayBuffer());
		const result = validateCadFile(f.name, buf);
		if (!result.valid) {
			invalidFiles.push({ filename: f.name, reason: result.reason });
		} else {
			loaded.push({ file: f, buf });
		}
	}
	if (invalidFiles.length > 0) {
		return json({ error: 'invalid_file', files: invalidFiles }, { status: 400 });
	}

	const id = randomUUID();
	const root = pathResolve(QUOTE_DIR);
	const quoteDir = pathResolve(root, id);
	if (!quoteDir.startsWith(root)) return bad('Internal error.');
	const filesDir = join(quoteDir, 'files');

	await mkdir(filesDir, { recursive: true });

	const storedFiles: { filename: string; size_bytes: number; stored_at: string }[] = [];
	const seenNames = new Set<string>();

	for (const { file: f, buf } of loaded) {
		const safe = sanitizeFilename(f.name);
		let candidate = safe;
		let suffix = 1;
		while (seenNames.has(candidate)) {
			const ext = extname(safe);
			const stem = safe.slice(0, safe.length - ext.length);
			candidate = `${stem}_${suffix}${ext}`;
			suffix++;
		}
		seenNames.add(candidate);

		const dest = join(filesDir, candidate);
		if (!pathResolve(dest).startsWith(filesDir)) return bad('Internal error.');
		await writeFile(dest, buf);
		storedFiles.push({
			filename: candidate,
			size_bytes: f.size,
			stored_at: `files/${candidate}`
		});
	}

	const nowIso = new Date().toISOString();
	const metadata: QuoteMetadata = {
		id,
		received_at: nowIso,
		contact: {
			name: nameTrim,
			email: emailTrim,
			company: companyTrim
		},
		request: {
			material_preference: material,
			quantity,
			deadline: deadline || null,
			notes: notesTrim
		},
		files: storedFiles,
		status: 'received',
		consent_at: nowIso
	};

	const metadataPath = join(quoteDir, 'metadata.json');
	// Persist the quote BEFORE notifying. The quote on disk is the source of
	// truth; a lost notification is recoverable from /admin/quotes, a lost quote
	// is not. Notification is best-effort and never blocks the 200 response.
	await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

	try {
		const notify = await sendQuoteNotifications(metadata);
		if (notify.operator === 'sent' || notify.customer === 'sent') {
			metadata.notified_at = new Date().toISOString();
			await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
		}
	} catch (err) {
		// sendQuoteNotifications is contractually non-throwing; this is belt-and-braces.
		console.error('[quote] notification dispatch error:', err);
	}

	return json({ id, status: 'received' });
};
