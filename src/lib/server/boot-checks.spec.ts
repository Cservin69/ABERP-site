import { describe, it, expect } from 'vitest';
import { runBootChecks, isVitest } from './boot-checks';
import { EXPECTED_BODY_SIZE_LIMIT } from './body-size-limit';

const PROD_ENV = {
	BODY_SIZE_LIMIT: String(EXPECTED_BODY_SIZE_LIMIT),
	ABERP_INTERNAL_BASE_URL: 'http://127.0.0.1:8080',
	ABERP_EMAIL_RELAY_TOKEN: 'relay-token-value',
	ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com'
};

describe('runBootChecks — green path', () => {
	it('returns ok=true when BODY_SIZE_LIMIT and all relay envs are present', () => {
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

describe('runBootChecks — F8 relay env', () => {
	it('flags F8 when ABERP_INTERNAL_BASE_URL is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_INTERNAL_BASE_URL;
		const v = runBootChecks({ env });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
		expect(f8?.message).toContain('ABERP_INTERNAL_BASE_URL');
	});

	it('flags F8 when ABERP_EMAIL_RELAY_TOKEN is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_EMAIL_RELAY_TOKEN;
		const v = runBootChecks({ env });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8?.message).toContain('ABERP_EMAIL_RELAY_TOKEN');
	});

	it('flags F8 when ABERP_SITE_OPERATOR_EMAIL is unset', () => {
		const env = { ...PROD_ENV };
		delete (env as Partial<typeof env>).ABERP_SITE_OPERATOR_EMAIL;
		const v = runBootChecks({ env });
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8?.message).toContain('ABERP_SITE_OPERATOR_EMAIL');
	});

	it('flags F8 when relay envs are present but whitespace-only (operator wiped them via blank EnvironmentFile entries)', () => {
		const v = runBootChecks({
			env: {
				...PROD_ENV,
				ABERP_INTERNAL_BASE_URL: '   ',
				ABERP_EMAIL_RELAY_TOKEN: '\t',
				ABERP_SITE_OPERATOR_EMAIL: '\n'
			}
		});
		expect(v.ok).toBe(false);
		const f8 = v.problems.find((p) => p.finding === 'F8');
		expect(f8).toBeDefined();
		// All three should be named in the message.
		expect(f8?.message).toContain('ABERP_INTERNAL_BASE_URL');
		expect(f8?.message).toContain('ABERP_EMAIL_RELAY_TOKEN');
		expect(f8?.message).toContain('ABERP_SITE_OPERATOR_EMAIL');
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
		// Sanity gate — the boot-checks module skips refuse-to-start in tests via
		// this helper, so a regression that breaks VITEST detection would silently
		// turn every test into a 503 in CI.
		expect(isVitest()).toBe(true);
	});
});
