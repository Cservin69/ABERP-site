import { verifyBodySizeLimit } from './body-size-limit';

/**
 * Refuse-to-start boot checks. The S285 review flagged two
 * [[trust-code-not-operator]] gaps where the storefront would boot green and
 * silently misbehave:
 *
 *   - F19: `BODY_SIZE_LIMIT` unset (or < 50 MB) — every priced writeback over
 *     the 512 KB adapter-node default 413s before the handler ever runs.
 *   - F8:  ABERP relay env unset (`ABERP_INTERNAL_BASE_URL`,
 *     `ABERP_EMAIL_RELAY_TOKEN`, `ABERP_SITE_OPERATOR_EMAIL`) — every
 *     customer email is silently dropped, discovered only when a customer
 *     complains.
 *
 * The S287 patch surfaced F1 as a `console.warn`. PR-09 escalates the
 * BODY_SIZE_LIMIT and relay checks to a fail-on-start so a misconfigured
 * deploy gets caught at boot, not on the first real customer's quote.
 *
 * The checks are skipped under vitest (`VITEST=true`) so the test suite can
 * import server modules without setting every prod env. The hooks.server.ts
 * `handle()` wraps `runBootChecks()` and 503s every request when the checks
 * fail — `process.exit(1)` would also work but would risk killing the test
 * process if something else slipped through; the per-request 503 is the
 * safer posture under adapter-node where there's no explicit "boot phase"
 * separate from the first request.
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
		ABERP_INTERNAL_BASE_URL: string;
		ABERP_EMAIL_RELAY_TOKEN: string;
		ABERP_SITE_OPERATOR_EMAIL: string;
	}>;
}

function isPresent(v: string | undefined | null): boolean {
	return typeof v === 'string' && v.trim().length > 0;
}

function checkRelayEnv(env: BootCheckOptions['env']): BootCheckProblem | null {
	const base = env?.ABERP_INTERNAL_BASE_URL ?? process.env.ABERP_INTERNAL_BASE_URL;
	const token = env?.ABERP_EMAIL_RELAY_TOKEN ?? process.env.ABERP_EMAIL_RELAY_TOKEN;
	const operator = env?.ABERP_SITE_OPERATOR_EMAIL ?? process.env.ABERP_SITE_OPERATOR_EMAIL;
	const missing: string[] = [];
	if (!isPresent(base)) missing.push('ABERP_INTERNAL_BASE_URL');
	if (!isPresent(token)) missing.push('ABERP_EMAIL_RELAY_TOKEN');
	if (!isPresent(operator)) missing.push('ABERP_SITE_OPERATOR_EMAIL');
	if (missing.length === 0) return null;
	return {
		finding: 'F8',
		message:
			`[aberp-site] ABERP relay envs missing: ${missing.join(', ')}. ` +
			`Per ADR-0007 the storefront's only egress for customer mail is the ABERP relay; ` +
			`without these the submission-received, priced-ready, and accepted-confirmation ` +
			`emails are silently dropped. Set all three in /etc/aberp-site.env or as systemd ` +
			`Environment= lines. See docs/reviews/S285-adversarial-storefront-arc.md finding F8.`
	};
}

/**
 * Pure verification — does not throw or exit. Returns a verdict the caller
 * (hooks.server.ts) decides what to do with. The caller decides the policy
 * (503 vs. process.exit vs. warn) based on its own context.
 */
export function runBootChecks(opts: BootCheckOptions = {}): BootCheckResult {
	const problems: BootCheckProblem[] = [];

	const bodyVerdict = verifyBodySizeLimit(opts.env?.BODY_SIZE_LIMIT ?? process.env.BODY_SIZE_LIMIT);
	if (!bodyVerdict.ok) {
		problems.push({ finding: 'F19', message: bodyVerdict.message });
	}

	const relayProblem = checkRelayEnv(opts.env);
	if (relayProblem) problems.push(relayProblem);

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
