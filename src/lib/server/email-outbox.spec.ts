import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

// email-outbox.ts reads ABERP_SITE_EMAIL_OUTBOX_DIR at module-load via a
// top-level const. Static `import { ... } from './email-outbox'` is hoisted
// above any top-level mutation here, so we MUST set the env var BEFORE the
// dynamic import inside each test. The pattern mirrors catalogue-store.spec.ts.
const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'aberp-outbox-'));
process.env.ABERP_SITE_EMAIL_OUTBOX_DIR = TMP_ROOT;

type OutboxModule = typeof import('./email-outbox');

async function loadOutbox(): Promise<OutboxModule> {
	return await import('./email-outbox');
}

beforeEach(() => {
	// Each test starts with a fresh root. We clean the *contents* of the env-set
	// directory rather than re-pointing the env var (the module captured the
	// path at first import and won't see a later mutation).
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function basePayload(over: Record<string, unknown> = {}) {
	return {
		to: ['ada@example.com'],
		cc: ['ops@abenerp.com'],
		subject: 'Test subject',
		body_text: 'Hello',
		body_html: '<p>Hello</p>',
		...over
	};
}

describe('generateUlid', () => {
	it('produces a 26-char Crockford-base32 id whose timestamp prefix sorts by time', async () => {
		const { generateUlid, isValidEntryId } = await loadOutbox();
		const id1 = generateUlid(1_700_000_000_000);
		const id2 = generateUlid(1_700_000_001_000);
		expect(id1).toHaveLength(26);
		expect(id2).toHaveLength(26);
		expect(isValidEntryId(id1)).toBe(true);
		expect(isValidEntryId(id2)).toBe(true);
		// Same-millisecond ids are not orderable, but a 1s gap MUST sort.
		expect(id2 > id1).toBe(true);
	});

	it('rejects non-ULID strings via isValidEntryId', async () => {
		const { isValidEntryId } = await loadOutbox();
		expect(isValidEntryId('not-a-ulid')).toBe(false);
		expect(isValidEntryId('A'.repeat(25))).toBe(false); // 25 chars
		expect(isValidEntryId('A'.repeat(27))).toBe(false); // 27 chars
		// Crockford forbids I, L, O, U.
		expect(isValidEntryId('I'.repeat(26))).toBe(false);
		expect(isValidEntryId('L'.repeat(26))).toBe(false);
		expect(isValidEntryId('O'.repeat(26))).toBe(false);
		expect(isValidEntryId('U'.repeat(26))).toBe(false);
	});
});

describe('enqueueEmail', () => {
	it('writes a queued entry with all fields and a fresh id', async () => {
		const { enqueueEmail, readEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const entry = await readEntry(id);
		expect(entry).not.toBeNull();
		expect(entry?.state).toBe('queued');
		expect(entry?.submitter).toBe('submission_received');
		expect(entry?.to).toEqual(['ada@example.com']);
		expect(entry?.cc).toEqual(['ops@abenerp.com']);
		expect(entry?.subject).toBe('Test subject');
		expect(entry?.attempt_n).toBe(0);
		expect(entry?.last_error).toBeNull();
		expect(entry?.sent_at).toBeNull();
		expect(entry?.audit_id).toBeNull();
		expect(entry?.claimed_at).toBeNull();
		// And the file landed in queued/.
		const queued = readdirSync(join(TMP_ROOT, 'queued'));
		expect(queued).toContain(`${id}.json`);
	});

	it('defaults cc to [] when the caller omits it', async () => {
		const { enqueueEmail, readEntry } = await loadOutbox();
		const { id } = await enqueueEmail({ to: ['x@y.z'], subject: 's', body_text: 't' }, 'other');
		const entry = await readEntry(id);
		expect(entry?.cc).toEqual([]);
	});

	it('round-trips attachments verbatim', async () => {
		const { enqueueEmail, readEntry } = await loadOutbox();
		const attachments = [
			{
				filename: 'quote.pdf',
				content_type: 'application/pdf',
				data_b64: Buffer.from('%PDF').toString('base64')
			}
		];
		const { id } = await enqueueEmail(basePayload({ attachments }), 'priced_ready');
		const entry = await readEntry(id);
		expect(entry?.attachments).toEqual(attachments);
	});
});

describe('listQueued', () => {
	it('returns queued entries in ascending id order', async () => {
		const { enqueueEmail, listQueued } = await loadOutbox();
		const r1 = await enqueueEmail(basePayload({ subject: 'first' }), 'submission_received');
		// Spin briefly so the ULIDs land in distinct milliseconds.
		await new Promise((r) => setTimeout(r, 5));
		const r2 = await enqueueEmail(basePayload({ subject: 'second' }), 'priced_ready');
		const list = await listQueued();
		expect(list).toHaveLength(2);
		expect(list[0].id).toBe(r1.id);
		expect(list[1].id).toBe(r2.id);
	});

	it('respects the limit option', async () => {
		const { enqueueEmail, listQueued } = await loadOutbox();
		for (let i = 0; i < 3; i++) {
			await enqueueEmail(basePayload({ subject: `m${i}` }), 'submission_received');
			await new Promise((r) => setTimeout(r, 2));
		}
		const list = await listQueued({ limit: 2 });
		expect(list).toHaveLength(2);
	});

	it('filters by since=<iso> on queued_at', async () => {
		const { enqueueEmail, listQueued } = await loadOutbox();
		await enqueueEmail(basePayload({ subject: 'before' }), 'submission_received');
		await new Promise((r) => setTimeout(r, 10));
		const cutoff = new Date().toISOString();
		await new Promise((r) => setTimeout(r, 10));
		const r2 = await enqueueEmail(basePayload({ subject: 'after' }), 'submission_received');
		const list = await listQueued({ since: cutoff });
		expect(list.map((e) => e.id)).toEqual([r2.id]);
	});

	it('filters by after=<id> cursor (strictly greater)', async () => {
		const { enqueueEmail, listQueued } = await loadOutbox();
		const r1 = await enqueueEmail(basePayload({ subject: 'one' }), 'submission_received');
		await new Promise((r) => setTimeout(r, 5));
		const r2 = await enqueueEmail(basePayload({ subject: 'two' }), 'submission_received');
		const list = await listQueued({ after: r1.id });
		expect(list.map((e) => e.id)).toEqual([r2.id]);
	});

	it('returns an empty list when the queue is empty', async () => {
		const { listQueued } = await loadOutbox();
		const list = await listQueued();
		expect(list).toEqual([]);
	});
});

describe('claimEntry', () => {
	it('atomically moves queued → claimed, bumps attempt_n, and stamps claimed_at', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const before = Date.now();
		const claimed = await claimEntry(id);
		const after = Date.now();
		expect(claimed).not.toBeNull();
		expect(claimed?.state).toBe('claimed');
		expect(claimed?.attempt_n).toBe(1);
		expect(claimed?.claimed_at).toBeTruthy();
		const claimedAtMs = Date.parse(claimed!.claimed_at as string);
		expect(claimedAtMs).toBeGreaterThanOrEqual(before);
		expect(claimedAtMs).toBeLessThanOrEqual(after);
		// The file lives in claimed/ now.
		expect(readdirSync(join(TMP_ROOT, 'queued'))).not.toContain(`${id}.json`);
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).toContain(`${id}.json`);
	});

	it('returns null on a second claim of the same entry (no double-claim race)', async () => {
		const { enqueueEmail, claimEntry } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const first = await claimEntry(id);
		const second = await claimEntry(id);
		expect(first).not.toBeNull();
		expect(second).toBeNull();
	});

	it('returns null when claiming an unknown id', async () => {
		const { claimEntry, generateUlid } = await loadOutbox();
		const result = await claimEntry(generateUlid());
		expect(result).toBeNull();
	});

	it('returns null when claiming a malformed id', async () => {
		const { claimEntry } = await loadOutbox();
		const result = await claimEntry('not-a-ulid');
		expect(result).toBeNull();
	});
});

describe('markSent', () => {
	it('transitions claimed → sent and records audit_id + sent_at', async () => {
		const { enqueueEmail, claimEntry, markSent } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const sent = await markSent(id, 'audit_evt_1');
		expect(sent.state).toBe('sent');
		expect(sent.audit_id).toBe('audit_evt_1');
		expect(sent.sent_at).toBeTruthy();
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).not.toContain(`${id}.json`);
		expect(readdirSync(join(TMP_ROOT, 'sent'))).toContain(`${id}.json`);
	});

	it('is idempotent on replay — second markSent returns the already-sent entry', async () => {
		const { enqueueEmail, claimEntry, markSent } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const first = await markSent(id, 'audit_evt_1');
		// A duplicate ABERP-side completion call must NOT overwrite the audit id
		// or move the file. First-writer-wins on the audit lineage.
		const second = await markSent(id, 'audit_evt_2');
		expect(second.audit_id).toBe('audit_evt_1');
		expect(second.sent_at).toBe(first.sent_at);
	});

	it('throws when the entry is not in claimed/ (e.g. still queued)', async () => {
		const { enqueueEmail, markSent } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await expect(markSent(id, 'evt')).rejects.toThrow(/not_claimed/);
	});

	it('throws on an invalid id', async () => {
		const { markSent } = await loadOutbox();
		await expect(markSent('xxx', 'evt')).rejects.toThrow(/invalid_entry_id/);
	});
});

describe('markFailed', () => {
	it('transitions claimed → failed and records last_error', async () => {
		const { enqueueEmail, claimEntry, markFailed } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const failed = await markFailed(id, 'smtp_5xx', 'relay refused');
		expect(failed.state).toBe('failed');
		expect(failed.last_error).toEqual({ class: 'smtp_5xx', detail: 'relay refused' });
		expect(readdirSync(join(TMP_ROOT, 'failed'))).toContain(`${id}.json`);
	});

	it('is idempotent on replay — second markFailed returns the already-failed entry', async () => {
		const { enqueueEmail, claimEntry, markFailed } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const first = await markFailed(id, 'smtp_5xx', 'relay refused');
		const second = await markFailed(id, 'smtp_4xx', 'other');
		expect(second.last_error).toEqual(first.last_error);
	});

	it('throws when the entry is not in claimed/', async () => {
		const { enqueueEmail, markFailed } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await expect(markFailed(id, 'x', 'y')).rejects.toThrow(/not_claimed/);
	});
});

describe('readEntry', () => {
	it('finds an entry in queued/, claimed/, sent/, and failed/ regardless of state', async () => {
		const { enqueueEmail, claimEntry, markSent, markFailed, readEntry } = await loadOutbox();
		// queued
		const r1 = await enqueueEmail(basePayload({ subject: 'q' }), 'submission_received');
		await new Promise((r) => setTimeout(r, 2));
		// claimed
		const r2 = await enqueueEmail(basePayload({ subject: 'c' }), 'submission_received');
		await claimEntry(r2.id);
		await new Promise((r) => setTimeout(r, 2));
		// sent
		const r3 = await enqueueEmail(basePayload({ subject: 's' }), 'submission_received');
		await claimEntry(r3.id);
		await markSent(r3.id, 'evt_3');
		await new Promise((r) => setTimeout(r, 2));
		// failed
		const r4 = await enqueueEmail(basePayload({ subject: 'f' }), 'submission_received');
		await claimEntry(r4.id);
		await markFailed(r4.id, 'x', 'y');

		expect((await readEntry(r1.id))?.state).toBe('queued');
		expect((await readEntry(r2.id))?.state).toBe('claimed');
		expect((await readEntry(r3.id))?.state).toBe('sent');
		expect((await readEntry(r4.id))?.state).toBe('failed');
	});

	it('returns null for an unknown id', async () => {
		const { readEntry, generateUlid } = await loadOutbox();
		expect(await readEntry(generateUlid())).toBeNull();
	});

	it('returns null for an invalid id', async () => {
		const { readEntry } = await loadOutbox();
		expect(await readEntry('not-a-ulid')).toBeNull();
	});
});

describe('atomic-write safety', () => {
	it('writes via tmp file + rename, leaving no .tmp- artefacts after enqueue', async () => {
		const { enqueueEmail } = await loadOutbox();
		await enqueueEmail(basePayload(), 'submission_received');
		const names = readdirSync(join(TMP_ROOT, 'queued'));
		const tmps = names.filter((n) => n.includes('.tmp-'));
		expect(tmps).toEqual([]);
	});

	it('survives a malformed JSON file in queued/ without throwing on list', async () => {
		const { enqueueEmail, listQueued } = await loadOutbox();
		// Pre-create queued/ then drop a malformed file.
		await enqueueEmail(basePayload(), 'submission_received');
		writeFileSync(join(TMP_ROOT, 'queued', 'AAAAAAAAAAAAAAAAAAAAAAAAAA.json'), 'not json');
		const list = await listQueued();
		// The one good entry still shows up; the malformed one is silently dropped.
		expect(list.length).toBe(1);
	});
});

describe('recoverStaleClaimed (S311 F1)', () => {
	it('returns [] when claimed/ is empty', async () => {
		const { recoverStaleClaimed } = await loadOutbox();
		const recovered = await recoverStaleClaimed();
		expect(recovered).toEqual([]);
	});

	it('does NOT recover a fresh claim (claimed_at within the TTL)', async () => {
		const { enqueueEmail, claimEntry, recoverStaleClaimed } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		// nowMs == real-now keeps the entry well within the default 600s TTL.
		const recovered = await recoverStaleClaimed({ nowMs: Date.now() });
		expect(recovered).toEqual([]);
		// Still in claimed/.
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).toContain(`${id}.json`);
	});

	it('recovers a claim whose claimed_at is older than the TTL', async () => {
		const { enqueueEmail, claimEntry, recoverStaleClaimed } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		// Fast-forward "now" by 1 hour — well past the 600s default TTL.
		const futureNow = Date.now() + 60 * 60 * 1000;
		const recovered = await recoverStaleClaimed({ nowMs: futureNow });
		expect(recovered).toEqual([id]);
		expect(readdirSync(join(TMP_ROOT, 'queued'))).toContain(`${id}.json`);
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).not.toContain(`${id}.json`);
	});

	it('treats claimed_at == null as "always stale" (covers pre-S311 wedged rows)', async () => {
		// Write a claimed entry directly with claimed_at = null. This is the
		// shape an entry would have on disk if it pre-dates the S311 field.
		const { enqueueEmail, recoverStaleClaimed, generateUlid, isValidEntryId } = await loadOutbox();
		void isValidEntryId;
		await enqueueEmail(basePayload(), 'submission_received'); // ensures dirs
		const id = generateUlid();
		const legacy = {
			id,
			queued_at: '2026-06-01T00:00:00Z',
			to: ['x@x.com'],
			cc: [],
			subject: 's',
			body_text: 't',
			submitter: 'submission_received',
			state: 'claimed',
			attempt_n: 1,
			last_error: null,
			sent_at: null,
			audit_id: null,
			claimed_at: null
		};
		writeFileSync(join(TMP_ROOT, 'claimed', `${id}.json`), JSON.stringify(legacy));
		const recovered = await recoverStaleClaimed({ nowMs: Date.now() });
		expect(recovered).toContain(id);
		expect(readdirSync(join(TMP_ROOT, 'queued'))).toContain(`${id}.json`);
	});
});

describe('listQueued — F1 auto-sweep', () => {
	it('auto-recovers stale-claimed entries on every list (no skipStaleClaimSweep)', async () => {
		const { enqueueEmail, claimEntry, listQueued } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		// 1 hour future → past TTL → list sweeps + returns the recovered row.
		const list = await listQueued({ nowMs: Date.now() + 60 * 60 * 1000 });
		expect(list.map((e) => e.id)).toContain(id);
		expect(readdirSync(join(TMP_ROOT, 'queued'))).toContain(`${id}.json`);
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).not.toContain(`${id}.json`);
	});

	it('skipStaleClaimSweep=true bypasses the sweep (used by tests that want pre-sweep state)', async () => {
		const { enqueueEmail, claimEntry, listQueued } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		await claimEntry(id);
		const list = await listQueued({
			nowMs: Date.now() + 60 * 60 * 1000,
			skipStaleClaimSweep: true
		});
		expect(list.map((e) => e.id)).not.toContain(id);
		expect(readdirSync(join(TMP_ROOT, 'claimed'))).toContain(`${id}.json`);
	});
});

describe('ensureDirs', () => {
	it('creates queued/claimed/sent/failed on first enqueue', async () => {
		const { enqueueEmail } = await loadOutbox();
		await enqueueEmail(basePayload(), 'submission_received');
		const top = readdirSync(TMP_ROOT);
		for (const s of ['queued', 'claimed', 'sent', 'failed']) {
			expect(top).toContain(s);
		}
	});
});

describe('entry JSON shape on disk', () => {
	it('is canonical (2-space pretty-printed) so operator hand-inspection is humane', async () => {
		const { enqueueEmail } = await loadOutbox();
		const { id } = await enqueueEmail(basePayload(), 'submission_received');
		const raw = readFileSync(join(TMP_ROOT, 'queued', `${id}.json`), 'utf8');
		expect(raw).toContain('\n  "id"');
	});
});
