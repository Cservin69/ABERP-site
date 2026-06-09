import { describe, it, expect } from 'vitest';
import { runBootChecks, isVitest } from './boot-checks';
import { EXPECTED_BODY_SIZE_LIMIT } from './body-size-limit';

/**
 * PR-11 / ADR-0009: F8 narrowed from the three-env relay check
 * (ABERP_INTERNAL_BASE_URL + ABERP_EMAIL_RELAY_TOKEN + ABERP_SITE_OPERATOR_EMAIL)
 * to ABERP_SITE_OPERATOR_EMAIL only. The relay envs are no longer consulted
 * by `email.ts` and so are not boot-check-enforced.
 */
const PROD_ENV = {
	BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT),
	ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com'
};

describe('runBootChecks — green path', () => {
	it('returns ok=true when BODY_SIZE_LIMIT and the operator inbox are present', () => {
		const v = runBootChecks({ env: PROD_ENV });
		expect(v.ok).toBe(true);
		expect(v.problems).toHaveLength(0);
	});
});

describe('runBootChecks — F19 BODY_SIZE_LIMIT', () => {
	it('flags F19 when BODY_SIZE_LIMIT is unset (the adapter-node 512 KB default that breaks priced writebacks)', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).BODY_SIZE_LIMIT;
		const v = runBootChecks({ env });
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
		const f19 = v.problems.find((p) => p.finding === 'F19');
		expect(f19?.message).toContain('BODY_SIZE_LIMIT');
	});

	it('flags F19 when BODY_SIZE_LIMIT is below the 50 MB floor (e.g. operator typoed 5 MB)', () => {
		const v = runBootChecks({ env: { ...PROD_ENV, BODY_SIZE_LIMIT: '5242880' } });
		expect(v.ok).toBe(false);
		expect(v.problems.map((p) => p.finding)).toContain('F19');
	});

	it('does NOT flag F19 when BODY_SIZE_LIMIT is exactly the expected floor', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT) }
		});
		expect(v.problems.map((p) => p.finding)).not.toContain('F19');
	});
});

describe('runBootChecks — F8 operator inbox', () => {
	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_OPERATOR_EMAIL;
		const v = runBootChecks({ env });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
		expect(f8?.message).toContain('ABERP_SITE_OPERATOR_EMAIL');
	});

	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is whitespace-only', () => {
		const v = runBootChecks({
			env: { ...PROD_ENV, ABERP_SITE_OPERATOR_EMAIL: '   \t  ' }
		});
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
	});

	it('does NOT flag F8 when only the deprecated relay envs are absent', () => {
		// ADR-0009 removed the relay envs from the boot check. A deploy that has
		// the operator inbox but no relay envs must boot green.
		const v = runBootChecks({ env: PROD_ENV });
		expect(v.problems.map((p) => p.finding)).not.toContain('F8');
	});

	it('combines F19 + F8 when both kinds of envs are missing — caller sees the full picture', () => {
		const v = runBootChecks({ env: {} });
		expect(v.ok).toBe(false);
		const findings = v.problems.map((p) => p.finding);
		expect(findings).toContain('F19');
		expect(findings).toContain('F8');
	});
});

describe('isVitest', () => {
	it('is true inside the vitest runner', () => {
		expect(isVitest()).toBe(true);
	});
});
