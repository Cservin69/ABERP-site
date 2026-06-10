import { describe, it, expect } from 'vitest';
import {
	runBootChecks,
	isVitest,
	probeOutboxDirSync,
	type OutboxDirProbeResult
} from './boot-checks';
import { EXPECTED_BODY_SIZE_LIMIT } from './body-size-limit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
	ABERP_SITE_EMAIL_OUTBOX_DIR: '/home/aberp/data/email-outbox',
	ABERP_SITE_CATALOGUE_DIR: '/home/aberp/data/catalogue'
};
const OK_PROBE = (): OutboxDirProbeResult => ({ ok: true });
// S343: the catalogue F-CAT check uses the same real probe by default, so
// PROD_ENV-driven tests stub it green the same way they stub the outbox probe.
// Without this the real probe would mkdir `/home/aberp/data/catalogue` on the
// CI runner and the green-path assertion (problems length 0) would fail.
const OK_PROBES = { outboxDirProbe: OK_PROBE, catalogueDirProbe: OK_PROBE };

describe('runBootChecks — green path', () => {
	it('returns ok=true when BODY_SIZE_LIMIT and the operator inbox and outbox dir are present', () => {
		const v = runBootChecks({ env: PROD_ENV, ...OK_PROBES });
		expect(v.ok).toBe(true);
		expect(v.problems).toHaveLength(0);
	});
});

describe('runBootChecks — F19 BODY_SIZE_LIMIT', () => {
	it('flags F19 when BODY_SIZE_LIMIT is unset (the adapter-node 512 KB default that breaks priced writebacks)', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).BODY_SIZE_LIMIT;
		const v = runBootChecks({ env, ...OK_PROBES });
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
		const f19 = v.problems.find((p) => p.finding === 'F19');
		expect(f19?.message).toContain('BODY_SIZE_LIMIT');
	});

	it('flags F19 when BODY_SIZE_LIMIT is below the 50 MB floor (e.g. operator typoed 5 MB)', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, BODY_SIZE_LIMIT: '5242880' },
			...OK_PROBES
		});
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
	});

	it('does NOT flag F19 when BODY_SIZE_LIMIT is exactly the expected floor', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT) },
			...OK_PROBES
		});
		expect(v.problems.map((p) => p.finding)).not.toContain('F19');
	});
});

describe('runBootChecks — F8 operator inbox', () => {
	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_OPERATOR_EMAIL;
		const v = runBootChecks({ env, ...OK_PROBES });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
		expect(f8?.message).toContain('ABERP_SITE_OPERATOR_EMAIL');
	});

	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is whitespace-only', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_OPERATOR_EMAIL: '   \t  ' },
			...OK_PROBES
		});
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
	});

	it('does NOT flag F8 when only the deprecated relay envs are absent', () => {
		// ADR-0009 removed the relay envs from the boot check. A deploy that has
		// the operator inbox but no relay envs must boot green.
		const v = runBootChecks({ env: PROD_ENV, ...OK_PROBES });
		expect(v.problems.map((p) => p.finding)).not.toContain('F8');
	});

	it('combines F19 + F8 when both kinds of envs are missing — caller sees the full picture', () => {
		const v = runBootChecks({ env: {}, ...OK_PROBES });
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
			outboxDirProbe: () => ({ ok: false, reason: 'EACCES' }),
			catalogueDirProbe: OK_PROBE
		});
		expect(v.ok).toBe(false);
		const f15 = v.problems.find((p) => p.finding === 'F15');
		expect(f15).toBeDefined();
		expect(f15?.message).toContain('EACCES');
		expect(f15?.message).toContain('/home/aberp/data/email-outbox');
	});

	it('flags F15 when ABERP_SITE_EMAIL_OUTBOX_DIR is a relative path', () => {
		// The real probe (probeOutboxDirSync) rejects non-absolute paths
		// without touching the disk, so this is end-to-end (no stub).
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_EMAIL_OUTBOX_DIR: './data/email-outbox' },
			catalogueDirProbe: OK_PROBE
		});
		expect(v.ok).toBe(false);
		const f15 = v.problems.find((p) => p.finding === 'F15');
		expect(f15).toBeDefined();
		expect(f15?.message).toContain('not absolute');
	});

	it('does NOT flag F15 when the probe approves', () => {
		const v = runBootChecks({ env: PROD_ENV, ...OK_PROBES });
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
			},
			catalogueDirProbe: OK_PROBE
		});
		expect(seenDir).toBe('/home/aberp/data/email-outbox');
	});
});

describe('runBootChecks — F-CAT catalogue dir writability (S343)', () => {
	it('s343_boot_check_passes_when_dir_writable', () => {
		const v = runBootChecks({ env: PROD_ENV, ...OK_PROBES });
		expect(v.problems.map((p) => p.finding)).not.toContain('F-CAT');
		expect(v.ok).toBe(true);
	});

	it('s343_boot_check_fails_with_actionable_message_when_not_writable', () => {
		const v = runBootChecks({
			env: PROD_ENV,
			outboxDirProbe: OK_PROBE,
			catalogueDirProbe: () => ({ ok: false, reason: 'EROFS: read-only file system' })
		});
		expect(v.ok).toBe(false);
		const fcat = v.problems.find((p) => p.finding === 'F-CAT');
		expect(fcat).toBeDefined();
		expect(fcat?.message).toContain('EROFS');
		expect(fcat?.message).toContain('/home/aberp/data/catalogue');
		expect(fcat?.message).toContain('ReadWritePaths');
	});

	it('flags F-CAT via the real probe when ABERP_SITE_CATALOGUE_DIR is relative', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_CATALOGUE_DIR: './data/catalogue' },
			outboxDirProbe: OK_PROBE
		});
		expect(v.ok).toBe(false);
		const fcat = v.problems.find((p) => p.finding === 'F-CAT');
		expect(fcat).toBeDefined();
		expect(fcat?.message).toContain('not absolute');
	});

	it('falls back to the canonical catalogue default path when the env is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_CATALOGUE_DIR;
		let seenDir: string | null = null;
		runBootChecks({
			env,
			outboxDirProbe: OK_PROBE,
			catalogueDirProbe: (dir) => {
				seenDir = dir;
				return { ok: true };
			}
		});
		expect(seenDir).toBe('/home/aberp/data/catalogue');
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

	it('red when the parent path is a regular file (mkdir failure surface)', () => {
		// S333 / PR-20: this used to probe `/proc/1/email-outbox-probe-x` to get
		// an unwritable parent. On the 2-core GitHub Linux runner that procfs
		// path wedged the worker thread inside the synchronous mkdir/access
		// syscall — the boot-checks worker never reported, vitest's pool waited
		// on it forever, and the whole `npm run test:unit` process hung at exit
		// until the 5-min CI cap (root-caused via why-is-node-running, see
		// project_aberp_site_ci_test_unit_hang memory). Probing a path *under a
		// regular file* reproduces the mkdir-failure branch deterministically and
		// portably (ENOTDIR on Linux + macOS), touching only a tmpdir we own — no
		// procfs, no permission/root guesswork, and the assertion always fires.
		const base = mkdtempSync(join(tmpdir(), 'outbox-probe-notdir-'));
		const file = join(base, 'a-file');
		writeFileSync(file, 'not a directory', 'utf8');
		try {
			const r = probeOutboxDirSync(join(file, 'child'));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain('mkdir failed');
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe('isVitest', () => {
	it('is true inside the vitest runner', () => {
		expect(isVitest()).toBe(true);
	});
});
