import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve as pathResolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const CATALOGUE_DIR = process.env.ABERP_SITE_CATALOGUE_DIR ?? './data/catalogue';

export const STOCK_STATUSES = [
	'in_stock',
	'source_1_2d',
	'source_3_7d',
	'source_2_4w',
	'special_order'
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_SET: ReadonlySet<string> = new Set(STOCK_STATUSES);

export interface CatalogueMaterial {
	grade: string;
	display_name: string;
	stock_status: StockStatus;
	lead_time_default_days: number;
}

export interface CatalogueSnapshot {
	materials: CatalogueMaterial[];
	received_at: string;
}

export const GRADE_MAX_LEN = 64;
export const DISPLAY_NAME_MAX_LEN = 200;
export const LEAD_TIME_MAX_DAYS = 365;
// S338 — real-world material grades, not sanitized identifiers. The push
// source is ABERP's `quoting_materials.grade` PRIMARY KEY, which holds the
// canonical industry designation an operator types ("6061-T6", "304",
// "Ti-6Al-4V", "Inconel 718", "17-4PH"). The original /^[A-Z][A-Z0-9_]*$/
// rejected every digit-first / hyphenated / spaced / lowercase grade, so
// `validateSnapshotBody` 400'd the *entire* push and the snapshot never
// landed — the live `/quote` fallback-dropdown defect. Accept the charset
// real grades use (alnum + space . _ + / -) while still requiring an
// alphanumeric first char and excluding all control chars (no CR/LF/NUL —
// the closed allowlist inherently rejects them, so grades stay safe as an
// HTML option value and as the `material_preference` echoed back to ABERP).
// This is the wire contract; ABERP's catalogue_push regression test pins
// the same set from the other end.
const GRADE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+/-]*$/;
// eslint-disable-next-line no-control-regex -- intentional: reject CR/LF/NUL injection in pushed display names
const HEADER_INJECTION_RE = /[\r\n\x00]/;

export type MaterialValidation =
	| { ok: true; material: CatalogueMaterial }
	| { ok: false; index: number; reason: string };

export function validateMaterialRow(value: unknown, index: number): MaterialValidation {
	if (!value || typeof value !== 'object') {
		return { ok: false, index, reason: 'row is not an object' };
	}
	const row = value as Record<string, unknown>;

	const grade = row.grade;
	if (typeof grade !== 'string' || grade.length === 0) {
		return { ok: false, index, reason: 'grade is required' };
	}
	if (grade.length > GRADE_MAX_LEN) {
		return { ok: false, index, reason: `grade exceeds ${GRADE_MAX_LEN} chars` };
	}
	if (!GRADE_RE.test(grade)) {
		return { ok: false, index, reason: 'grade must match /^[A-Z][A-Z0-9_]*$/' };
	}

	const display_name = row.display_name;
	if (typeof display_name !== 'string' || display_name.trim().length === 0) {
		return { ok: false, index, reason: 'display_name is required' };
	}
	if (display_name.length > DISPLAY_NAME_MAX_LEN) {
		return { ok: false, index, reason: `display_name exceeds ${DISPLAY_NAME_MAX_LEN} chars` };
	}
	if (HEADER_INJECTION_RE.test(display_name)) {
		return { ok: false, index, reason: 'display_name contains invalid characters' };
	}

	const stock_status = row.stock_status;
	if (typeof stock_status !== 'string' || !STOCK_STATUS_SET.has(stock_status)) {
		return { ok: false, index, reason: 'stock_status not in closed enum' };
	}

	const lead_time_default_days = row.lead_time_default_days;
	if (
		typeof lead_time_default_days !== 'number' ||
		!Number.isInteger(lead_time_default_days) ||
		lead_time_default_days < 0 ||
		lead_time_default_days > LEAD_TIME_MAX_DAYS
	) {
		return {
			ok: false,
			index,
			reason: `lead_time_default_days must be integer in [0, ${LEAD_TIME_MAX_DAYS}]`
		};
	}

	return {
		ok: true,
		material: {
			grade,
			display_name,
			stock_status: stock_status as StockStatus,
			lead_time_default_days
		}
	};
}

export type SnapshotValidation =
	| { ok: true; materials: CatalogueMaterial[] }
	| { ok: false; reason: string };

export function validateSnapshotBody(body: unknown): SnapshotValidation {
	if (!body || typeof body !== 'object') {
		return { ok: false, reason: 'body must be a JSON object' };
	}
	const materialsRaw = (body as Record<string, unknown>).materials;
	if (!Array.isArray(materialsRaw)) {
		return { ok: false, reason: '`materials` must be an array' };
	}
	const out: CatalogueMaterial[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < materialsRaw.length; i++) {
		const v = validateMaterialRow(materialsRaw[i], i);
		if (!v.ok) {
			return { ok: false, reason: `materials[${v.index}]: ${v.reason}` };
		}
		if (seen.has(v.material.grade)) {
			return { ok: false, reason: `duplicate grade ${v.material.grade}` };
		}
		seen.add(v.material.grade);
		out.push(v.material);
	}
	return { ok: true, materials: out };
}

function catalogueFile(): string {
	return pathResolve(join(CATALOGUE_DIR, 'materials.json'));
}

export async function readCatalogueSnapshot(): Promise<CatalogueSnapshot | null> {
	try {
		const raw = await readFile(catalogueFile(), 'utf8');
		const parsed = JSON.parse(raw) as CatalogueSnapshot;
		if (!parsed || !Array.isArray(parsed.materials)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function writeCatalogueAtomic(snapshot: CatalogueSnapshot): Promise<void> {
	const target = catalogueFile();
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${randomUUID()}`;
	await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
	await rename(tmp, target);
}

/**
 * Returns the set of grades currently in the cached catalogue, or an empty set
 * if no catalogue has been pushed yet. Used by /api/quote to widen the
 * legacy ALLOWED_MATERIALS check to "legacy preference OR current catalogue grade."
 */
export async function currentCatalogueGrades(): Promise<Set<string>> {
	const snap = await readCatalogueSnapshot();
	if (!snap) return new Set();
	return new Set(snap.materials.map((m) => m.grade));
}
