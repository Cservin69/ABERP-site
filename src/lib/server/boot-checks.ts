import {
	mkdirSync,
	accessSync,
	writeFileSync,
	unlinkSync,
	constants as fsConstants
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyBodySizeLimit } from './body-size-limit';
import { OUTBOX_DIR_DEFAULT_PATH } from './email-outbox';
import { CATALOGUE_DIR_DEFAULT_PATH } from './catalogue-store';

/**
 * Refuse-to-start boot checks. The S285 review flagged two
 * [[trust-code-not-operator]] gaps where the storefront would boot green and
 * silently misbehave:
 *
 *   - F19: `BODY_SIZE_LIMIT` unset (or < 50 MB) — every priced writeback over
 *     the 512 KB adapter-node default 413s before the handler ever runs.
 *   - F8:  ABERP relay env unset — every customer email was silently dropped,
 *     discovered only when a customer complained. PR-11 (ADR-0009) retires
 *     the push-based relay; the only env still load-bearing for the email
 *     path is `ABERP_SITE_OPERATOR_EMAIL` (the inbox we CC on customer mail).
 *     `ABERP_INTERNAL_BASE_URL` / `ABERP_EMAIL_RELAY_TOKEN` are no longer
 *     consulted by `email.ts`; they remain on the deploy docs as deprecated
 *     envs for the duration of the email-relay deprecation window and are
 *     not checked here.
 *
 * The S287 patch surfaced F1 as a `console.warn`. PR-09 escalated the
 * BODY_SIZE_LIMIT and relay checks to a fail-on-start; PR-11 narrows F8 to
 * `ABERP_SITE_OPERATOR_EMAIL` only.
 *
 * ## S311 / F15 — outbox dir writability
 *
 * The S309 review found that `email-outbox.ts` defaulted to the relative
 * path `./data/email-outbox` (process-CWD-dependent), and the env var was
 * never boot-checked. A Lightsail systemd unit that forgot to set
 * `ABERP_SITE_EMAIL_OUTBOX_DIR` would silently write the queue to the
 * application volume, which gets wiped on every deploy. F15 sets the
 * canonical default to `/home/aberp/data/email-outbox` (matches the
 * existing `ABERP_SITE_QUOTE_DIR` pattern that bootstrap creates and
 * that the systemd unit's `ReadWritePaths=` whitelist allows) AND
 * requires that the directory exists, is absolute, and is writable. The
 * check creates a sentinel `.boot-check-<uuid>` file and removes it
 * before returning; the round-trip is what actually proves writability.
 *
 * The checks are skipped under vitest (`VITEST=true`) so the test suite can
 * import server modules without setting every prod env.
 */

export interface BootCheckProblem {
	finding: string;
	message: string;
}

export interface BootCheckResult {
	ok: boolean;
	problems: BootCheckProblem[];
}

interface BootCheckOptions {
	/** Override `process.env`-derived values, for tests. */
	env?: Partial<{
		BODY_SIZE_LIMIT: string;
		ABERP_SITE_OPERATOR_EMAIL: string;
		ABERP_SITE_EMAIL_OUTBOX_DIR: string;
		ABERP_SITE_CATALOGUE_DIR: string;
	}>;
	/**
	 * Override the outbox-dir writability probe — tests stub this so they can
	 * assert "F15 fires when the dir is unwritable" without needing real
	 * chmod-444 tmpdirs (which behave inconsistently across CI runners).
	 */
	outboxDirProbe?: (dir: string) => OutboxDirProbeResult;
	/**
	 * Override the catalogue-dir writability probe — same rationale as
	 * `outboxDirProbe`. Reuses the `probeOutboxDirSync` round-trip (mkdir +
	 * W_OK + sentinel) when unset.
	 */
	catalogueDirProbe?: (dir: string) => OutboxDirProbeResult;
}

export type OutboxDirProbeResult = { ok: true } | { ok: false; reason: string };

function isPresent(v: string | undefined | null): boolean {
	return typeof v === 'string' && v.trim().length > 0;
}

function checkOperatorInbox(env: BootCheckOptions['env']): BootCheckProblem | null {
	const operator = env?.ABERP_SITE_OPERATOR_EMAIL ?? process.env.ABERP_SITE_OPERATOR_EMAIL;
	if (isPresent(operator)) return null;
	return {
		finding: 'F8',
		message:
			'[aberp-site] ABERP_SITE_OPERATOR_EMAIL is not set. Per ADR-0009 this is ' +
			'the only env knob still load-bearing for the email path — it is the inbox ' +
			'we CC on every customer mail before enqueueing to the storefront-side ' +
			'email outbox. Without it, submission-received / priced-ready / ' +
			'accepted-confirmation are silently skipped. Set it in /etc/aberp-site.env ' +
			'or as a systemd Environment= line.'
	};
}

/**
 * Verify the outbox directory is absolute, exists (or is creatable), and is
 * writable. Sync because `runBootChecks` is sync; the round-trip is a few
 * inode operations on a healthy box, < 1 ms.
 */
export function probeOutboxDirSync(dir: string): OutboxDirProbeResult {
	if (!isAbsolute(dir)) {
		return {
			ok: false,
			reason:
				`path is not absolute (got "${dir}"); a process-CWD-relative path ` +
				'silently lands on the deploy-volatile application volume.'
		};
	}
	try {
		mkdirSync(dir, { recursive: true });
	} catch (e) {
		return { ok: false, reason: `mkdir failed: ${(e as Error).message}` };
	}
	try {
		accessSync(dir, fsConstants.W_OK);
	} catch (e) {
		return { ok: false, reason: `access W_OK failed: ${(e as Error).message}` };
	}
	const sentinel = join(dir, `.boot-check-${randomUUID()}`);
	try {
		writeFileSync(sentinel, 'ok', 'utf8');
		unlinkSync(sentinel);
	} catch (e) {
		return { ok: false, reason: `sentinel write/unlink failed: ${(e as Error).message}` };
	}
	return { ok: true };
}

function checkOutboxDir(
	env: BootCheckOptions['env'],
	probe: BootCheckOptions['outboxDirProbe']
): BootCheckProblem | null {
	const raw =
		env?.ABERP_SITE_EMAIL_OUTBOX_DIR ??
		process.env.ABERP_SITE_EMAIL_OUTBOX_DIR ??
		OUTBOX_DIR_DEFAULT_PATH;
	const probeFn = probe ?? probeOutboxDirSync;
	const result = probeFn(raw);
	if (result.ok) return null;
	return {
		finding: 'F15',
		message:
			`[aberp-site] ABERP_SITE_EMAIL_OUTBOX_DIR="${raw}" is not usable: ` +
			`${result.reason}. ` +
			`Set it to ${OUTBOX_DIR_DEFAULT_PATH} (the ADR-0009 canonical path) and ` +
			`make sure the systemd unit's StateDirectory or tmpfiles.d entry creates ` +
			`the directory writable by the aberp-site user. ` +
			`See docs/reviews/S309-adversarial-option-d-arc.md finding F15.`
	};
}

/**
 * ## S343 / F-CAT — catalogue dir writability
 *
 * Same shape as F15, for the material catalogue snapshot. `catalogue-store.ts`
 * defaulted to the process-CWD-relative `./data/catalogue`, which `pathResolve`
 * anchored inside the immutable release dir on Lightsail (`ProtectSystem=strict`,
 * `ReadWritePaths=/home/aberp/data`). Every PUT to `/api/catalogue/materials`
 * then failed with `EROFS` and the `/quote` dropdown never populated. The
 * default is now `/home/aberp/data/catalogue`, the same canonical state dir as
 * the outbox, and F-CAT proves the directory is absolute, present, and writable
 * at boot using the same `probeOutboxDirSync` round-trip.
 */
function checkCatalogueDir(
	env: BootCheckOptions['env'],
	probe: BootCheckOptions['catalogueDirProbe']
): BootCheckProblem | null {
	const raw =
		env?.ABERP_SITE_CATALOGUE_DIR ??
		process.env.ABERP_SITE_CATALOGUE_DIR ??
		CATALOGUE_DIR_DEFAULT_PATH;
	const probeFn = probe ?? probeOutboxDirSync;
	const result = probeFn(raw);
	if (result.ok) return null;
	return {
		finding: 'F-CAT',
		message:
			`[aberp-site] ABERP_SITE_CATALOGUE_DIR="${raw}" is not usable: ` +
			`${result.reason}. ` +
			`Set it to ${CATALOGUE_DIR_DEFAULT_PATH} (the same canonical state dir as the ` +
			`email outbox) and make sure the systemd unit's ReadWritePaths includes ` +
			`/home/aberp/data. Release dirs are immutable (ProtectSystem=strict), so a ` +
			`CWD-relative catalogue path fails every /api/catalogue/materials PUT with EROFS.`
	};
}

/**
 * Pure verification — does not throw or exit. Returns a verdict the caller
 * (hooks.server.ts) decides what to do with.
 */
export function runBootChecks(opts: BootCheckOptions = {}): BootCheckResult {
	const problems: BootCheckProblem[] = [];

	const bodyVerdict = verifyBodySizeLimit(opts.env?.BODY_SIZE_LIMIT ?? process.env.BODY_SIZE_LIMIT);
	if (!bodyVerdict.ok) {
		problems.push({ finding: 'F19', message: bodyVerdict.message });
	}

	const inboxProblem = checkOperatorInbox(opts.env);
	if (inboxProblem) problems.push(inboxProblem);

	const outboxProblem = checkOutboxDir(opts.env, opts.outboxDirProbe);
	if (outboxProblem) problems.push(outboxProblem);

	const catalogueProblem = checkCatalogueDir(opts.env, opts.catalogueDirProbe);
	if (catalogueProblem) problems.push(catalogueProblem);

	return { ok: problems.length === 0, problems };
}

/**
 * True when we are running inside the vitest test runner. Vitest sets
 * `process.env.VITEST=true` automatically; we honor it so boot checks do not
 * trip in unit tests that legitimately do not set every prod env.
 */
export function isVitest(): boolean {
	return process.env.VITEST === 'true';
}
