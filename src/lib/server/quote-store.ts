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
