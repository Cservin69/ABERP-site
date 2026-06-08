import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve as pathResolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const QUOTE_DIR = process.env.ABERP_SITE_QUOTE_DIR ?? './data/quotes';

export interface QuoteFileEntry {
	filename: string;
	size_bytes: number;
	stored_at: string;
}

export interface QuoteStatusHistoryEntry {
	at: string;
	from: string;
	to: string;
	notes: string;
}

/**
 * Priced-quote sub-record written by ABERP via POST /api/quotes/{id}/priced
 * (ADR-0004). The storefront never inspects `breakdown_json` — it is opaque
 * pricing-engine output and is held verbatim per ADR-0002 (engine in ABERP).
 *
 * Addendum 2 (stock_alert sticky flag) lands here as a top-level field: the
 * customer-facing status page reads it to render the "stock changed since
 * issue" banner. Addendum 1 fields (requires_5_axis, thin_wall_present) live
 * inside `breakdown_json` and are deliberately not surfaced as typed fields —
 * the storefront does not gate UX on them.
 */
export interface QuotePricing {
	received_at: string;
	valid_until: string;
	breakdown_json: Record<string, unknown>;
	pdf_stored_at: 'priced.pdf';
	feature_graph_hash: string;
	extractor_version: string;
	engine_version: string;
	stock_alert: boolean;
}

export interface QuoteMetadata {
	id: string;
	received_at: string;
	contact: {
		name: string;
		email: string;
		company: string;
	};
	request: {
		material_preference: string;
		quantity: number | null;
		deadline: string | null;
		notes: string;
	};
	files: QuoteFileEntry[];
	status: string;
	consent_at: string;
	status_history?: QuoteStatusHistoryEntry[];
	/** ISO timestamp set once submission notifications have been dispatched. */
	notified_at?: string;
	pricing?: QuotePricing;
}

function quoteRoot(): string {
	return pathResolve(QUOTE_DIR);
}

function quoteDir(id: string): string | null {
	const root = quoteRoot();
	const candidate = pathResolve(root, id);
	if (!candidate.startsWith(root + '/') && candidate !== root) return null;
	if (candidate === root) return null;
	return candidate;
}

export async function listQuotes(): Promise<QuoteMetadata[]> {
	const root = quoteRoot();
	let entries: string[];
	try {
		const s = await stat(root);
		if (!s.isDirectory()) return [];
		entries = await readdir(root);
	} catch {
		return [];
	}
	const out: QuoteMetadata[] = [];
	for (const name of entries) {
		const dir = quoteDir(name);
		if (!dir) continue;
		try {
			const st = await stat(dir);
			if (!st.isDirectory()) continue;
			const raw = await readFile(join(dir, 'metadata.json'), 'utf8');
			out.push(JSON.parse(raw) as QuoteMetadata);
		} catch {
			continue;
		}
	}
	out.sort((a, b) => (b.received_at ?? '').localeCompare(a.received_at ?? ''));
	return out;
}

export async function readQuote(id: string): Promise<QuoteMetadata | null> {
	const dir = quoteDir(id);
	if (!dir) return null;
	try {
		const raw = await readFile(join(dir, 'metadata.json'), 'utf8');
		return JSON.parse(raw) as QuoteMetadata;
	} catch {
		return null;
	}
}

export async function writeQuoteAtomic(id: string, metadata: QuoteMetadata): Promise<void> {
	const dir = quoteDir(id);
	if (!dir) throw new Error('Invalid quote id.');
	const target = join(dir, 'metadata.json');
	const tmp = join(dir, `metadata.json.tmp-${randomUUID()}`);
	await writeFile(tmp, JSON.stringify(metadata, null, 2), 'utf8');
	await rename(tmp, target);
}

export function quoteFilePath(id: string, filename: string): string | null {
	const dir = quoteDir(id);
	if (!dir) return null;
	const filesDir = pathResolve(dir, 'files');
	const candidate = pathResolve(filesDir, filename);
	if (!candidate.startsWith(filesDir + '/')) return null;
	return candidate;
}

/**
 * Absolute path of the priced-quote PDF for a quote, or null if the id is
 * invalid. The filename is a constant (`priced.pdf`) per ADR-0004 §"Persistence"
 * — knowing the path without a metadata read keeps the download handler trivial.
 */
export function pricedPdfPath(id: string): string | null {
	const dir = quoteDir(id);
	if (!dir) return null;
	return pathResolve(dir, 'priced.pdf');
}

/**
 * Atomic write of the priced PDF: tmpfile + rename, same posture as
 * writeQuoteAtomic. The quote directory is created by the original
 * submission, so a missing dir here is a real error (caller should 404).
 */
export async function writePricedPdfAtomic(id: string, bytes: Uint8Array): Promise<void> {
	const target = pricedPdfPath(id);
	if (!target) throw new Error('Invalid quote id.');
	const dir = quoteDir(id);
	if (!dir) throw new Error('Invalid quote id.');
	const tmp = join(dir, `priced.pdf.tmp-${randomUUID()}`);
	await writeFile(tmp, bytes);
	await rename(tmp, target);
}
