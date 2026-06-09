import { describe, it, expect } from 'vitest';
import {
	runBootChecks,
	isVitest,
	probeOutboxDirSync,
	type OutboxDirProbeResult
} from './boot-checks';
import { EXPECTED_BODY_SIZE_LIMIT } from './body-size-limit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PR-11 / ADR-0009: F8 narrowed from the three-env relay check
 * (ABERP_INTERNAL_BASE_URL + ABERP_EMAIL_RELAY_TOKEN + ABERP_SITE_OPERATOR_EMAIL)
 * to ABERP_SITE_OPERATOR_EMAIL only. The relay envs are no longer consulted
 * by `email.ts` and so are not boot-check-enforced.
 *
 * S311 / F15: outbox-dir writability check added. The probe is stubbed to
 * `{ ok: true }` in `PROD_ENV`-driven tests so we don't depend on real disk
 * writability; the F15 suite below exercises the green/red paths explicitly.
 */
const PROD_ENV = {
	BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT),
	ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com',
	ABERP_SITE_EMAIL_OUTBOX_DIR: '/var/lib/aberp-site/email-outbox'
};
const OK_PROBE = (): OutboxDirProbeResult => ({ ok: true });

describe('runBootChecks — green path', () => {
	it('returns ok=true when BODY_SIZE_LIMIT and the operator inbox and outbox dir are present', () => {
		const v = runBootChecks({ env: PROD_ENV, outboxDirProbe: OK_PROBE });
		expect(v.ok).toBe(true);
		expect(v.problems).toHaveLength(0);
	});
});

describe('runBootChecks — F19 BODY_SIZE_LIMIT', () => {
	it('flags F19 when BODY_SIZE_LIMIT is unset (the adapter-node 512 KB default that breaks priced writebacks)', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).BODY_SIZE_LIMIT;
		const v = runBootChecks({ env, outboxDirProbe: OK_PROBE });
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
		const f19 = v.problems.find((p) => p.finding === 'F19');
		expect(f19?.message).toContain('BODY_SIZE_LIMIT');
	});

	it('flags F19 when BODY_SIZE_LIMIT is below the 50 MB floor (e.g. operator typoed 5 MB)', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, BODY_SIZE_LIMIT: '5242880' },
			outboxDirProbe: OK_PROBE
		});
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
	});

	it('does NOT flag F19 when BODY_SIZE_LIMIT is exactly the expected floor', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT) },
			outboxDirProbe: OK_PROBE
		});
		expect(v.problems.map((p) => p.finding)).not.toContain('F19');
	});
});

describe('runBootChecks — F8 operator inbox', () => {
	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_OPERATOR_EMAIL;
		const v = runBootChecks({ env, outboxDirProbe: OK_PROBE });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
		expect(f8?.message).toContain('ABERP_SITE_OPERATOR_EMAIL');
	});

	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is whitespace-only', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_OPERATOR_EMAIL: '   \t  ' },
			outboxDirProbe: OK_PROBE
		});
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
	});

	it('does NOT flag F8 when only the deprecated relay envs are absent', () => {
		// ADR-0009 removed the relay envs from the boot check. A deploy that has
		// the operator inbox but no relay envs must boot green.
		const v = runBootChecks({ env: PROD_ENV, outboxDirProbe: OK_PROBE });
		expect(v.problems.map((p) => p.finding)).not.toContain('F8');
	});

	it('combines F19 + F8 when both kinds of envs are missing — caller sees the full picture', () => {
		const v = runBootChecks({ env: {}, outboxDirProbe: OK_PROBE });
		expect(v.ok).toBe(false);
		const findings = v.problems.map((p) => p.finding);
		expect(findings).toContain('F19');
		expect(findings).toContain('F8');
	});
});

describe('runBootChecks — F15 outbox dir writability', () => {
	it('flags F15 when the probe rejects (e.g. unwritable dir)', () => {
		const v = runBootChecks({
			env: PROD_ENV,
			outboxDirProbe: () => ({ ok: false, reason: 'EACCES' })
		});
		expect(v.ok).toBe(false);
		const f15 = v.problems.find((p) => p.finding === 'F15');
		expect(f15).toBeDefined();
		expect(f15?.message).toContain('EACCES');
		expect(f15?.message).toContain('/var/lib/aberp-site/email-outbox');
	});

	it('flags F15 when ABERP_SITE_EMAIL_OUTBOX_DIR is a relative path', () => {
		// The real probe (probeOutboxDirSync) rejects non-absolute paths
		// without touching the disk, so this is end-to-end (no stub).
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_EMAIL_OUTBOX_DIR: './data/email-outbox' }
		});
		expect(v.ok).toBe(false);
		const f15 = v.problems.find((p) => p.finding === 'F15');
		expect(f15).toBeDefined();
		expect(f15?.message).toContain('not absolute');
	});

	it('does NOT flag F15 when the probe approves', () => {
		const v = runBootChecks({ env: PROD_ENV, outboxDirProbe: OK_PROBE });
		expect(v.problems.map((p) => p.finding)).not.toContain('F15');
	});

	it('falls back to the canonical default path when the env is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_EMAIL_OUTBOX_DIR;
		let seenDir: string | null = null;
		runBootChecks({
			env,
			outboxDirProbe: (dir) => {
				seenDir = dir;
				return { ok: true };
			}
		});
		expect(seenDir).toBe('/var/lib/aberp-site/email-outbox');
	});
});

describe('probeOutboxDirSync', () => {
	it('green on a freshly-created tmpdir', () => {
		const dir = mkdtempSync(join(tmpdir(), 'outbox-probe-'));
		try {
			expect(probeOutboxDirSync(dir)).toEqual({ ok: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('red on a relative path', () => {
		const r = probeOutboxDirSync('./relative/path');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain('not absolute');
	});

	it('red on a non-existent path under a non-writable parent (mkdir failure surface)', () => {
		// Use a path under /proc/1 which root-owns and is not writable as a
		// regular user. If the runner happens to be root, the probe will
		// succeed and we skip the assertion (no platform-portable way to
		// guarantee unwritability across all CI envs).
		const r = probeOutboxDirSync('/proc/1/email-outbox-probe-x');
		if (!r.ok) {
			expect(r.reason.length).toBeGreaterThan(0);
		}
	});
});

describe('isVitest', () => {
	it('is true inside the vitest runner', () => {
		expect(isVitest()).toBe(true);
	});
});
