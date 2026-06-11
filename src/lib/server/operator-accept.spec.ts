/**
 * S354 / ADR-0005 amendment — operator-accept HMAC lib.
 *
 * The headline test is the CROSS-IMPLEMENTATION vector: the same inputs
 * must yield the same hex digest as ABERP's Rust `operator_accept.rs`
 * (`s354_hmac_is_stable_across_runs_for_fixed_inputs`). If either side's
 * canonical-message format or HMAC construction drifts, this pin breaks.
 */
import { describe, it, expect, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
	envState: {
		ABERP_SITE_ADMIN_TOKEN: 'unit-test-bearer-secret'
	} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

import {
	isOperatorAcceptChannel,
	operatorAcceptCanonicalMessage,
	operatorAcceptSignature,
	verifyOperatorAcceptSignature,
	OPERATOR_ACCEPT_CHANNELS
} from './operator-accept';

const QID = '00000000-0000-0000-0000-000000000001';
const TS_MS = 1_780_000_000_000;

describe('operator-accept channel vocab', () => {
	it('accepts exactly the four closed channels', () => {
		for (const c of OPERATOR_ACCEPT_CHANNELS) {
			expect(isOperatorAcceptChannel(c)).toBe(true);
		}
		for (const bad of ['', 'Phone', 'approved', 'sms', 'in person', 'PHONE', 42, null]) {
			expect(isOperatorAcceptChannel(bad)).toBe(false);
		}
	});
});

describe('operator-accept canonical message', () => {
	it('is domain-separated and field-ordered', () => {
		expect(operatorAcceptCanonicalMessage(QID, 'phone', TS_MS, 'ervin')).toBe(
			`${QID}|operator_accept|phone|${TS_MS}|ervin`
		);
	});
});

describe('operator-accept signature', () => {
	it('matches the ABERP Rust cross-impl vector for fixed inputs', () => {
		// envState secret is 'unit-test-bearer-secret' — the SAME secret
		// the Rust `s354_hmac_is_stable_across_runs_for_fixed_inputs` test
		// uses. The expected hex MUST equal the Rust pin.
		const sig = operatorAcceptSignature(QID, 'phone', TS_MS, 'ervin');
		expect(sig).toBe('66c8b4f0b6b44c01b580a6c079464f8b957a56e9ba0e667e074591e541c1a749');
	});

	it('verifies a freshly signed signature', () => {
		const sig = operatorAcceptSignature(QID, 'phone', TS_MS, 'ervin');
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS, 'ervin', sig)).toBe(true);
	});

	it('rejects a tampered bound field', () => {
		const sig = operatorAcceptSignature(QID, 'phone', TS_MS, 'ervin');
		expect(verifyOperatorAcceptSignature(QID, 'email', TS_MS, 'ervin', sig)).toBe(false);
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS + 1, 'ervin', sig)).toBe(false);
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS, 'anna', sig)).toBe(false);
	});

	it('rejects a malformed / missing signature without throwing', () => {
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS, 'ervin', undefined)).toBe(false);
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS, 'ervin', 'nothex')).toBe(false);
		expect(verifyOperatorAcceptSignature(QID, 'phone', TS_MS, 'ervin', 'ab')).toBe(false);
	});
});
