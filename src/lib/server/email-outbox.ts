import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve as pathResolve } from 'node:path';

/**
 * Storefront-side email outbox queue (ADR-0009). SERVER-ONLY.
 *
 * Replaces the push-based `email-relay.ts` (ADR-0007). Outbound customer mail
 * is no longer POSTed to ABERP across a Cloudflare Tunnel; instead the
 * storefront persists each send request as a queue file and ABERP's existing
 * poll daemon consumes the queue and SMTP-relays each message itself.
 *
 * State transitions are filesystem renames between subdirectories under
 * `queueRoot()`, the same atomic-rename posture used by `quote-store.ts`:
 *
 *   queued/<id>.json   →   claimed/<id>.json   →   sent/<id>.json
 *                                             →   failed/<id>.json
 *
 * Ids are ULIDs (Crockford-base32 timestamp prefix + random tail) so the
 * directory listing sorts lexicographically by `queued_at` and a since-cursor
 * filter can compare ids directly without a stat-each-file pass.
 *
 * The four public-facing endpoints under `/api/internal/email-queue` are the
 * only callers of `listQueued` / `claimEntry` / `markSent` / `markFailed`. The
 * three storefront call sites (submission-received, priced-ready,
 * accept-confirmation) only call `enqueueEmail`.
 */

const OUTBOX_DIR = process.env.ABERP_SITE_EMAIL_OUTBOX_DIR ?? './data/email-outbox';

const STATES = ['queued', 'claimed', 'sent', 'failed'] as const;
export type EmailQueueState = (typeof STATES)[number];

export type EmailSubmitter =
	| 'submission_received'
	| 'priced_ready'
	| 'accept_confirmation'
	| 'other';

export interface EmailQueueAttachment {
	filename: string;
	content_type: string;
	data_b64: string;
}

export interface EmailEnqueueRequest {
	to: string[];
	cc?: string[];
	subject: string;
	body_text: string;
	body_html?: string;
	attachments?: EmailQueueAttachment[];
}

export interface EmailQueueEntry {
	id: string;
	queued_at: string;
	to: string[];
	cc: string[];
	subject: string;
	body_text: string;
	body_html?: string;
	attachments?: EmailQueueAttachment[];
	submitter: EmailSubmitter;
	state: EmailQueueState;
	attempt_n: number;
	last_error: { class: string; detail: string } | null;
	sent_at: string | null;
	audit_id: string | null;
}

/**
 * Crockford base32 alphabet (no I, L, O, U) per Spec ULID. Total length
 * 26 chars (10 timestamp + 16 randomness). The timestamp half is a 48-bit
 * millisecond Unix timestamp big-endian; the randomness half is 80 bits.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number): string {
	let n = now;
	const out = new Array<string>(10);
	for (let i = 9; i >= 0; i--) {
		const mod = n % 32;
		out[i] = CROCKFORD[mod];
		n = Math.floor(n / 32);
	}
	return out.join('');
}

function encodeRandom(): string {
	// 16 chars × 5 bits = 80 bits of randomness. Read 10 bytes (80 bits) and
	// slice 5 bits at a time. The bit-walk avoids a BigInt path on the hot
	// enqueue write.
	const bytes = randomBytes(10);
	const out = new Array<string>(16);
	let bitBuf = 0;
	let bitCount = 0;
	let outIdx = 0;
	for (let i = 0; i < 10; i++) {
		bitBuf = (bitBuf << 8) | bytes[i];
		bitCount += 8;
		while (bitCount >= 5 && outIdx < 16) {
			bitCount -= 5;
			const v = (bitBuf >> bitCount) & 31;
			out[outIdx++] = CROCKFORD[v];
		}
	}
	return out.join('');
}

/** Public for tests. Generates a 26-char ULID at the given timestamp. */
export function generateUlid(now: number = Date.now()): string {
	return encodeTime(now) + encodeRandom();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidEntryId(id: string): boolean {
	return ULID_RE.test(id);
}

function queueRoot(): string {
	return pathResolve(OUTBOX_DIR);
}

function stateDir(state: EmailQueueState): string {
	return join(queueRoot(), state);
}

function entryPath(state: EmailQueueState, id: string): string {
	return join(stateDir(state), `${id}.json`);
}

async function ensureDirs(): Promise<void> {
	const root = queueRoot();
	await mkdir(root, { recursive: true });
	for (const s of STATES) {
		await mkdir(join(root, s), { recursive: true });
	}
}

async function readEntryFromState(
	state: EmailQueueState,
	id: string
): Promise<EmailQueueEntry | null> {
	if (!isValidEntryId(id)) return null;
	try {
		const raw = await readFile(entryPath(state, id), 'utf8');
		const parsed = JSON.parse(raw) as EmailQueueEntry;
		return parsed;
	} catch {
		return null;
	}
}

async function writeEntryAtomic(state: EmailQueueState, entry: EmailQueueEntry): Promise<void> {
	const dir = stateDir(state);
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `${entry.id}.json.tmp-${randomUUID()}`);
	await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
	await rename(tmp, entryPath(state, entry.id));
}

/**
 * Enqueue a new email. Always lands in `queued/`. Returns the generated id so
 * the caller can log it; fire-and-forget call sites can ignore the result.
 *
 * Per [[post-issue-async]] this is meant to be called inside a `setImmediate`
 * wrapper from the customer-facing request paths — the disk write is fast on
 * a healthy box but a wedged inode never blocks the 200 OK.
 */
export async function enqueueEmail(
	payload: EmailEnqueueRequest,
	submitter: EmailSubmitter
): Promise<{ id: string }> {
	await ensureDirs();
	const id = generateUlid();
	const queuedAt = new Date().toISOString();
	const entry: EmailQueueEntry = {
		id,
		queued_at: queuedAt,
		to: payload.to,
		cc: payload.cc ?? [],
		subject: payload.subject,
		body_text: payload.body_text,
		body_html: payload.body_html,
		attachments: payload.attachments,
		submitter,
		state: 'queued',
		attempt_n: 0,
		last_error: null,
		sent_at: null,
		audit_id: null
	};
	await writeEntryAtomic('queued', entry);
	return { id };
}

export interface ListQueuedOptions {
	/** ISO timestamp lower bound on `queued_at`. Inclusive. */
	since?: string;
	/** Entry-id cursor; entries strictly greater than this id are returned. */
	after?: string;
	/** Max entries to return. Defaults to 50. Clamped to 200. */
	limit?: number;
}

/**
 * List queued entries in ascending id order (= ascending queued_at because
 * ULID prefixes are time). Filters by `since` (ISO timestamp) and `after`
 * (entry-id cursor) if either is provided.
 *
 * Reads the `queued/` directory only — does NOT scan claimed/sent/failed.
 * A polled ABERP that wants visibility into in-flight entries calls the
 * dedicated state endpoints (none ship in v1, by design — the queue is
 * the source-of-truth ABERP needs; sent/failed are operator-debug surfaces).
 */
export async function listQueued(opts: ListQueuedOptions = {}): Promise<EmailQueueEntry[]> {
	const limit = Math.min(opts.limit ?? 50, 200);
	await ensureDirs();
	let names: string[];
	try {
		names = await readdir(stateDir('queued'));
	} catch {
		return [];
	}
	const ids = names
		.filter((n) => n.endsWith('.json'))
		.map((n) => n.slice(0, -'.json'.length))
		.filter((id) => isValidEntryId(id));
	ids.sort(); // lexicographic = chronological for ULID

	const out: EmailQueueEntry[] = [];
	for (const id of ids) {
		if (opts.after && id <= opts.after) continue;
		const entry = await readEntryFromState('queued', id);
		if (!entry) continue;
		if (opts.since && entry.queued_at < opts.since) continue;
		out.push(entry);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Atomically move an entry `queued → claimed`. Returns the entry (with
 * `attempt_n` bumped and `state='claimed'`) on success, null if the entry is
 * not in `queued/` (either already claimed, already terminal, or never
 * existed).
 *
 * The atomicity guarantee comes from filesystem `rename`: under POSIX, a
 * rename from path A to path B is atomic within a mountpoint, so two
 * concurrent claims race exactly one of them to success and the other gets a
 * `null` back from the post-rename re-read. Within v1's single-ABERP-instance
 * topology this is overkill; under the eventual SaaS topology it's the
 * load-bearing invariant.
 */
export async function claimEntry(id: string): Promise<EmailQueueEntry | null> {
	if (!isValidEntryId(id)) return null;
	await ensureDirs();
	const from = entryPath('queued', id);
	const to = entryPath('claimed', id);
	try {
		await rename(from, to);
	} catch {
		return null; // not in queued/ — already claimed, or never existed
	}
	const entry = await readEntryFromState('claimed', id);
	if (!entry) return null;
	const updated: EmailQueueEntry = {
		...entry,
		state: 'claimed',
		attempt_n: entry.attempt_n + 1
	};
	await writeEntryAtomic('claimed', updated);
	return updated;
}

/**
 * Mark a claimed entry as sent, recording ABERP's `audit_id`. Idempotent: a
 * replay against an already-sent entry with the same `audit_id` is a no-op
 * 200; a replay with a *different* `audit_id` returns the existing entry
 * unchanged (the first writer wins, which is the conservative posture — we'd
 * rather record the earliest audit lineage than overwrite it).
 *
 * Returns the persisted entry. Throws if the id is invalid or the entry is
 * neither in `claimed/` nor already in `sent/`.
 */
export async function markSent(id: string, audit_id: string): Promise<EmailQueueEntry> {
	if (!isValidEntryId(id)) throw new Error('invalid_entry_id');
	await ensureDirs();

	// Idempotent replay path — already in sent/.
	const alreadySent = await readEntryFromState('sent', id);
	if (alreadySent) return alreadySent;

	const entry = await readEntryFromState('claimed', id);
	if (!entry) throw new Error('not_claimed');

	const sentAt = new Date().toISOString();
	const updated: EmailQueueEntry = {
		...entry,
		state: 'sent',
		sent_at: sentAt,
		audit_id
	};
	// Write to sent/ first, then unlink claimed/ by rename of the new file
	// into place. Because the entry has the same id, we use rename of a
	// freshly-written sent/<id>.json over the path — but the simpler shape is:
	// write the updated entry into claimed/ (so the JSON content is up to
	// date), then rename claimed/<id>.json → sent/<id>.json atomically.
	await writeEntryAtomic('claimed', updated);
	await rename(entryPath('claimed', id), entryPath('sent', id));
	return updated;
}

/**
 * Mark a claimed entry as failed, recording the error classification ABERP
 * supplied. Idempotent on replay (first writer wins on `last_error`).
 *
 * Throws if the id is invalid or the entry is neither in `claimed/` nor
 * already in `failed/`.
 */
export async function markFailed(
	id: string,
	error_class: string,
	error_detail: string
): Promise<EmailQueueEntry> {
	if (!isValidEntryId(id)) throw new Error('invalid_entry_id');
	await ensureDirs();

	const alreadyFailed = await readEntryFromState('failed', id);
	if (alreadyFailed) return alreadyFailed;

	const entry = await readEntryFromState('claimed', id);
	if (!entry) throw new Error('not_claimed');

	const updated: EmailQueueEntry = {
		...entry,
		state: 'failed',
		last_error: { class: error_class, detail: error_detail }
	};
	await writeEntryAtomic('claimed', updated);
	await rename(entryPath('claimed', id), entryPath('failed', id));
	return updated;
}

/**
 * Read an entry from any state. Returns null if the id is not present anywhere
 * (or invalid). Probe order is queued → claimed → sent → failed because that
 * matches the expected hit rate on the listing/lookup paths.
 *
 * Exported so the route handlers can return the canonical entry shape on
 * idempotent replays without re-deriving which state directory it lives in.
 */
export async function readEntry(id: string): Promise<EmailQueueEntry | null> {
	if (!isValidEntryId(id)) return null;
	for (const s of STATES) {
		const entry = await readEntryFromState(s, id);
		if (entry) return entry;
	}
	return null;
}

/** Exported for test reset. Returns the absolute path of the queue root. */
export function __queueRootForTests(): string {
	return queueRoot();
}

/** Exported so the validation in the GET endpoint can canonicalise `since`. */
export function isValidIsoTimestamp(v: string): boolean {
	if (typeof v !== 'string' || v.length === 0) return false;
	const ms = Date.parse(v);
	return Number.isFinite(ms);
}
