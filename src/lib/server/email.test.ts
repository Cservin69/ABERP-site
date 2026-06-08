import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// quote-store reads `process.env.ABERP_SITE_QUOTE_DIR` at MODULE LOAD via a
// top-level const, and static `import` calls below are hoisted above any
// top-level statement here. We MUST set the env var BEFORE the quote-store
// import chain runs — vi.hoisted is the only block that fires earlier than
// the import resolution. (S277 / PR-02 finding, repeated again in PR-04.)
const { mockEnv, TMP_ROOT } = vi.hoisted(() => {
	// Dynamic require avoids the vi.hoisted "no external references" rule.
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM imports resolve
	const fs = require('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const path = require('node:path');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const os = require('node:os');
	const root = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-email-'));
	process.env.ABERP_SITE_QUOTE_DIR = root;
	return {
		mockEnv: {} as Record<string, string | undefined>,
		TMP_ROOT: root as string
	};
});

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(mockEnv as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

import {
	isEmailConfigured,
	buildOperatorEmail,
	buildCustomerEmail,
	buildPricedReadyEmail,
	buildAcceptedConfirmationEmail,
	sendQuoteNotifications,
	sendPricedReadyEmail,
	sendAcceptedConfirmationEmail,
	buildAcceptUrl,
	__resetRateLimit
} from './email';
import type { QuoteMetadata } from './quote-store';
import { verifyAcceptToken } from './quote-token';

function configure(extra: Record<string, string> = {}): void {
	Object.assign(mockEnv, {
		ABERP_INTERNAL_BASE_URL: 'https://aberp.example',
		ABERP_EMAIL_RELAY_TOKEN: 'relay-token',
		ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com',
		ABERP_SITE_PUBLIC_URL: 'https://abenerp.com',
		QUOTE_STATUS_SIGNING_KEY: 'unit-test-signing-key-0123456789abcdef',
		...extra
	});
}

function clearEnv(): void {
	for (const k of Object.keys(mockEnv)) delete mockEnv[k];
}

function makeQuote(over: Partial<QuoteMetadata> = {}): QuoteMetadata {
	return {
		id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		received_at: '2026-06-02T10:00:00.000Z',
		contact: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Eng' },
		request: {
			material_preference: 'aluminum',
			quantity: 5,
			deadline: '2026-07-01',
			notes: 'tight tol'
		},
		files: [{ filename: 'part.step', size_bytes: 1234, stored_at: 'files/part.step' }],
		status: 'received',
		consent_at: '2026-06-02T10:00:00.000Z',
		...over
	};
}

const fetchMock = vi.fn();

beforeEach(() => {
	clearEnv();
	__resetRateLimit();
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	mkdirSync(TMP_ROOT, { recursive: true });
	fetchMock.mockReset();
	// A Response body is a one-shot stream — using mockResolvedValue would hand
	// the SAME Response to every call, and the second call's `.json()` would see
	// an empty body. Construct a fresh Response per invocation.
	fetchMock.mockImplementation(
		async () =>
			new Response(JSON.stringify({ audit_id: 'evt_ok' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
	);
	vi.stubGlobal('fetch', fetchMock);
});

describe('isEmailConfigured', () => {
	it('is false when neither relay env nor operator inbox is present', () => {
		expect(isEmailConfigured()).toBe(false);
	});

	it('is false when relay envs are present but operator inbox is unset', () => {
		Object.assign(mockEnv, {
			ABERP_INTERNAL_BASE_URL: 'https://aberp.example',
			ABERP_EMAIL_RELAY_TOKEN: 't'
		});
		expect(isEmailConfigured()).toBe(false);
	});

	it('is true once relay envs and operator inbox are configured', () => {
		configure();
		expect(isEmailConfigured()).toBe(true);
	});
});

describe('buildOperatorEmail', () => {
	it('summarizes the quote and links to the admin detail page', () => {
		const msg = buildOperatorEmail(makeQuote(), 'https://abenerp.com');
		expect(msg.subject).toBe('New quote request — Ada Lovelace');
		expect(msg.text).toContain(
			'https://abenerp.com/admin/quotes/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
		);
		expect(msg.text).toContain('Email: ada@example.com');
		expect(msg.text).toContain('Files: 1');
	});

	it('omits optional fields that are absent', () => {
		const msg = buildOperatorEmail(
			makeQuote({
				request: { material_preference: 'unknown', quantity: null, deadline: null, notes: '' }
			}),
			'https://abenerp.com'
		);
		expect(msg.text).not.toContain('Quantity:');
		expect(msg.text).not.toContain('Deadline:');
		expect(msg.text).not.toContain('Notes:');
	});

	it('HTML-escapes user-controlled content', () => {
		const msg = buildOperatorEmail(
			makeQuote({ contact: { name: '<script>x</script>', email: 'a@b.co', company: 'A & B' } }),
			'https://abenerp.com'
		);
		expect(msg.html).toContain('&lt;script&gt;');
		expect(msg.html).not.toContain('<script>x</script>');
		expect(msg.html).toContain('A &amp; B');
	});

	it('strips newlines from the subject (header-injection defense)', () => {
		const msg = buildOperatorEmail(
			makeQuote({ contact: { name: 'Evil\r\nBcc: victim@x.com', email: 'a@b.co', company: '' } }),
			'https://abenerp.com'
		);
		expect(msg.subject).not.toContain('\n');
		expect(msg.subject).not.toContain('\r');
	});
});

describe('buildCustomerEmail', () => {
	it('addresses the customer by name and includes the reference id', () => {
		const msg = buildCustomerEmail(makeQuote());
		expect(msg.text).toContain('Hi Ada Lovelace,');
		expect(msg.text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
		expect(msg.html).toContain('<strong>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</strong>');
	});

	it('falls back to a generic greeting when name is empty', () => {
		const msg = buildCustomerEmail(
			makeQuote({ contact: { name: '', email: 'a@b.co', company: '' } })
		);
		expect(msg.text).toContain('Hi there,');
	});
});

describe('buildPricedReadyEmail', () => {
	it('includes the accept URL prominently and references the valid_until date', () => {
		const q = makeQuote({
			status: 'quoted',
			pricing: {
				received_at: '2026-06-08T10:00:00.000Z',
				valid_until: '2026-07-08',
				breakdown_json: {},
				pdf_stored_at: 'priced.pdf',
				feature_graph_hash: 'blake3:abc',
				extractor_version: 'v1',
				engine_version: 'v1',
				stock_alert: false
			}
		});
		const msg = buildPricedReadyEmail(q, 'https://abenerp.com/q/x/accept?ts=...&sig=...');
		expect(msg.subject).toContain('készen áll');
		expect(msg.text).toContain('https://abenerp.com/q/x/accept?ts=...&sig=...');
		expect(msg.text).toContain('2026-07-08');
		expect(msg.html).toContain('Accept this quote');
	});
});

describe('buildAcceptedConfirmationEmail', () => {
	it('thanks the customer and includes the reference id', () => {
		const msg = buildAcceptedConfirmationEmail(makeQuote());
		expect(msg.subject).toContain('elfogadva');
		expect(msg.text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
		expect(msg.text).toContain('two business days');
	});
});

describe('buildAcceptUrl', () => {
	it('issues a URL whose ts+sig verify under verifyAcceptToken', () => {
		configure();
		const url = buildAcceptUrl('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
		const parsed = new URL(url);
		expect(parsed.pathname).toBe('/q/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/accept');
		const ts = parsed.searchParams.get('ts');
		const sig = parsed.searchParams.get('sig');
		expect(ts).toBeTruthy();
		expect(sig).toBeTruthy();
		expect(
			verifyAcceptToken('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ts as string, sig as string)
		).toBe(true);
	});
});

describe('sendQuoteNotifications', () => {
	it('is a no-op when the relay is unconfigured', async () => {
		const res = await sendQuoteNotifications(makeQuote());
		expect(res).toEqual({ operator: 'skipped', customer: 'skipped', reason: 'unconfigured' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('relays operator + customer mail when configured', async () => {
		configure();
		const res = await sendQuoteNotifications(makeQuote());
		expect(res.operator).toBe('sent');
		expect(res.customer).toBe('sent');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const tos = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).to);
		expect(tos).toContainEqual(['ops@abenerp.com']);
		expect(tos).toContainEqual(['ada@example.com']);
	});

	it('cc-includes the operator on the customer mail', async () => {
		configure();
		await sendQuoteNotifications(makeQuote());
		const customerCall = fetchMock.mock.calls.find((c) => {
			const body = JSON.parse(String((c[1] as RequestInit).body));
			return body.to[0] === 'ada@example.com';
		});
		expect(customerCall).toBeTruthy();
		const body = JSON.parse(String((customerCall![1] as RequestInit).body));
		expect(body.cc).toEqual(['ops@abenerp.com']);
	});

	it('does not throw and reports failure when the relay rejects', async () => {
		configure();
		fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
		const res = await sendQuoteNotifications(makeQuote());
		expect(res.operator).toBe('failed');
		expect(res.customer).toBe('failed');
	});

	it('applies a per-recipient cooldown across repeat submissions', async () => {
		configure();
		const first = await sendQuoteNotifications(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001' })
		);
		expect(first.customer).toBe('sent');
		const second = await sendQuoteNotifications(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' })
		);
		expect(second.operator).toBe('skipped');
		expect(second.customer).toBe('skipped');
		// Only the first submission's two mails went out.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('enforces a global send ceiling', async () => {
		configure();
		let lastCustomer = 'sent';
		for (let i = 0; i < 35; i++) {
			const res = await sendQuoteNotifications(
				makeQuote({
					id: `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`,
					contact: { name: `User ${i}`, email: `user${i}@example.com`, company: '' }
				})
			);
			lastCustomer = res.customer;
		}
		expect(lastCustomer).toBe('skipped');
	});

	it('skips operator notification when ABERP_SITE_OPERATOR_EMAIL is unset (no SMTP_FROM fallback)', async () => {
		configure({ ABERP_SITE_OPERATOR_EMAIL: '' });
		const res = await sendQuoteNotifications(makeQuote());
		// Without an operator inbox configured the module is unconfigured per ADR-0007 —
		// the relay decides the *from* identity, the storefront only knows *to*.
		expect(res.operator).toBe('skipped');
		expect(res.customer).toBe('skipped');
		expect(res.reason).toBe('unconfigured');
	});
});

describe('sendPricedReadyEmail', () => {
	const QUOTE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

	function pricedQuote(): QuoteMetadata {
		return makeQuote({
			status: 'quoted',
			pricing: {
				received_at: '2026-06-08T10:00:00.000Z',
				valid_until: '2026-07-08',
				breakdown_json: {},
				pdf_stored_at: 'priced.pdf',
				feature_graph_hash: 'blake3:abc',
				extractor_version: 'v1',
				engine_version: 'v1',
				stock_alert: false
			}
		});
	}

	it('returns skipped + unconfigured when the relay is not configured', async () => {
		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('unconfigured');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('attaches the priced PDF when present on disk and includes the accept link in the body', async () => {
		configure();
		mkdirSync(join(TMP_ROOT, QUOTE_ID), { recursive: true });
		// Write the priced PDF directly with node:fs — going through quote-store's
		// writePricedPdfAtomic would defeat the load-order trick (we'd have to
		// import the helper, but that's the very import we deferred to avoid the
		// quote-store module-load race documented up top).
		writeFileSync(join(TMP_ROOT, QUOTE_ID, 'priced.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));

		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('sent');
		expect(r.audit_id).toBe('evt_ok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		expect(body.attachments).toHaveLength(1);
		expect(body.attachments[0].filename).toBe('quote.pdf');
		expect(body.attachments[0].content_type).toBe('application/pdf');
		expect(body.attachments[0].data_b64).toBe(
			Buffer.from([0x25, 0x50, 0x44, 0x46]).toString('base64')
		);
		// Accept link is in the body text.
		expect(body.body_text).toMatch(/\/q\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\/accept\?ts=/);
	});

	it('still sends the email when the priced PDF is missing on disk (link-only fallback)', async () => {
		configure();
		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('sent');
		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		expect(body.attachments).toBeUndefined();
	});

	it('reports failure but does not throw when the relay rejects', async () => {
		configure();
		fetchMock.mockImplementation(async () => new Response('', { status: 503 }));
		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('failed');
	});
});

describe('sendAcceptedConfirmationEmail', () => {
	it('returns skipped + unconfigured when the relay is not configured', async () => {
		const r = await sendAcceptedConfirmationEmail(makeQuote());
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('unconfigured');
	});

	it('relays the confirmation and returns the audit_id', async () => {
		configure();
		const r = await sendAcceptedConfirmationEmail(makeQuote());
		expect(r.status).toBe('sent');
		expect(r.audit_id).toBe('evt_ok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
		expect(body.to).toEqual(['ada@example.com']);
		expect(body.cc).toEqual(['ops@abenerp.com']);
		expect(body.subject).toContain('elfogadva');
	});
});
