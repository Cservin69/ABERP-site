import { verifyBodySizeLimit } from './body-size-limit';

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
	}>;
}

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
