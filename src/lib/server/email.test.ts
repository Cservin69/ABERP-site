import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PR-11 (ADR-0009) rewires email.ts from the push-based `sendEmailViaABERP`
 * onto the pull-based `enqueueEmail`. This test suite covers the new
 * behaviour: every "send" call lands as a queue entry under
 * `${ABERP_SITE_EMAIL_OUTBOX_DIR}/queued/`, and the rate-limit + sanitization
 * postures inherited from PR-09 are preserved.
 *
 * Note: the legacy push-path coverage (mocked `fetch`, audit_id round-trips)
 * lives on in `email-relay.spec.ts` for as long as `email-relay.ts` is kept
 * around per ADR-0009's deprecation note. This file no longer mocks fetch.
 */

const { mockEnv, TMP_QUOTE_ROOT, TMP_OUTBOX_ROOT } = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM imports
	const fs = require('node:fs');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const path = require('node:path');
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- as above
	const os = require('node:os');
	const quoteRoot = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-email-q-'));
	const outboxRoot = fs.mkdtempSync(path.resolve(os.tmpdir(), 'aberp-email-out-'));
	// Set BEFORE static imports resolve (quote-store + email-outbox both read
	// process.env at module load).
	process.env.ABERP_SITE_QUOTE_DIR = quoteRoot;
	process.env.ABERP_SITE_EMAIL_OUTBOX_DIR = outboxRoot;
	return {
		mockEnv: {} as Record<string, string | undefined>,
		TMP_QUOTE_ROOT: quoteRoot as string,
		TMP_OUTBOX_ROOT: outboxRoot as string
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
	buildSubmissionReceivedEmail,
	sendQuoteNotifications,
	sendPricedReadyEmail,
	sendAcceptedConfirmationEmail,
	sendSubmissionReceivedEmail,
	buildAcceptUrl,
	__resetRateLimit
} from './email';
import type { QuoteMetadata } from './quote-store';
import { verifyAcceptToken } from './quote-token';

function configure(extra: Record<string, string> = {}): void {
	Object.assign(mockEnv, {
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

function queuedFiles(): Array<{ name: string; entry: Record<string, unknown> }> {
	const dir = join(TMP_OUTBOX_ROOT, 'queued');
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: Array<{ name: string; entry: Record<string, unknown> }> = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		if (name.includes('.tmp-')) continue;
		const raw = readFileSync(join(dir, name), 'utf8');
		out.push({ name, entry: JSON.parse(raw) as Record<string, unknown> });
	}
	return out;
}

beforeEach(() => {
	clearEnv();
	__resetRateLimit();
	for (const root of [TMP_QUOTE_ROOT, TMP_OUTBOX_ROOT]) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		mkdirSync(root, { recursive: true });
	}
});

describe('isEmailConfigured', () => {
	it('is false when the operator inbox is unset', () => {
		expect(isEmailConfigured()).toBe(false);
	});

	it('is true once ABERP_SITE_OPERATOR_EMAIL is configured', () => {
		configure();
		expect(isEmailConfigured()).toBe(true);
	});

	it('no longer requires ABERP_INTERNAL_BASE_URL or ABERP_EMAIL_RELAY_TOKEN (ADR-0009)', () => {
		Object.assign(mockEnv, { ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com' });
		// Relay-era envs are absent on purpose — the queue path doesn't read them.
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

describe('sendQuoteNotifications (legacy operator+customer pair)', () => {
	it('is a no-op when the operator inbox is unconfigured', async () => {
		const res = await sendQuoteNotifications(makeQuote());
		expect(res).toEqual({ operator: 'skipped', customer: 'skipped', reason: 'unconfigured' });
		expect(queuedFiles()).toHaveLength(0);
	});

	it('enqueues operator + customer mail when configured', async () => {
		configure();
		const res = await sendQuoteNotifications(makeQuote());
		expect(res.operator).toBe('queued');
		expect(res.customer).toBe('queued');
		const files = queuedFiles();
		expect(files).toHaveLength(2);
		const recipients = files.map((f) => (f.entry.to as string[])[0]);
		expect(recipients).toContain('ops@abenerp.com');
		expect(recipients).toContain('ada@example.com');
	});

	it('cc-includes the operator on the customer mail', async () => {
		configure();
		await sendQuoteNotifications(makeQuote());
		const customer = queuedFiles().find((f) => (f.entry.to as string[])[0] === 'ada@example.com');
		expect(customer).toBeTruthy();
		expect(customer?.entry.cc).toEqual(['ops@abenerp.com']);
	});

	it('applies a per-recipient cooldown across repeat submissions', async () => {
		configure();
		const first = await sendQuoteNotifications(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001' })
		);
		expect(first.customer).toBe('queued');
		const second = await sendQuoteNotifications(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' })
		);
		expect(second.operator).toBe('skipped');
		expect(second.customer).toBe('skipped');
		// Only the first submission's two enqueues landed.
		expect(queuedFiles()).toHaveLength(2);
	});

	it('enforces a global send ceiling', async () => {
		configure();
		let lastCustomer = 'queued';
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

	it('skips operator notification when ABERP_SITE_OPERATOR_EMAIL is unset', async () => {
		const res = await sendQuoteNotifications(makeQuote());
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

	it('returns skipped + unconfigured when the operator inbox is not configured', async () => {
		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('unconfigured');
		expect(queuedFiles()).toHaveLength(0);
	});

	it('attaches the priced PDF when present on disk and includes the accept link in the body', async () => {
		configure();
		mkdirSync(join(TMP_QUOTE_ROOT, QUOTE_ID), { recursive: true });
		writeFileSync(
			join(TMP_QUOTE_ROOT, QUOTE_ID, 'priced.pdf'),
			Buffer.from([0x25, 0x50, 0x44, 0x46])
		);

		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('queued');
		expect(r.entry_id).toBeTruthy();
		const files = queuedFiles();
		expect(files).toHaveLength(1);
		const entry = files[0].entry as {
			attachments: { filename: string; content_type: string; data_b64: string }[];
			body_text: string;
		};
		expect(entry.attachments).toHaveLength(1);
		expect(entry.attachments[0].filename).toBe('quote.pdf');
		expect(entry.attachments[0].content_type).toBe('application/pdf');
		expect(entry.attachments[0].data_b64).toBe(
			Buffer.from([0x25, 0x50, 0x44, 0x46]).toString('base64')
		);
		expect(entry.body_text).toMatch(/\/q\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\/accept\?ts=/);
	});

	it('still enqueues when the priced PDF is missing on disk (link-only fallback)', async () => {
		configure();
		const r = await sendPricedReadyEmail(pricedQuote());
		expect(r.status).toBe('queued');
		const entry = queuedFiles()[0].entry as { attachments?: unknown };
		expect(entry.attachments).toBeUndefined();
	});
});

describe('buildSubmissionReceivedEmail', () => {
	it('includes the bilingual HU + EN body, reference id, timestamp, and status link', () => {
		const msg = buildSubmissionReceivedEmail(
			makeQuote(),
			'https://abenerp.com/q/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?t=tok'
		);
		expect(msg.subject).toContain('Áben Consulting — Submission received, quote #aaaaaaaa');
		expect(msg.text).toContain('Köszönjük az ajánlatkérést');
		expect(msg.text).toContain('Thank you for your quote request');
		expect(msg.text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
		expect(msg.text).toContain('2026-06-02T10:00:00.000Z');
		expect(msg.text).toContain('https://abenerp.com/q/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?t=tok');
	});

	it('html-escapes the status URL and reference id', () => {
		const msg = buildSubmissionReceivedEmail(makeQuote(), 'https://abenerp.com/q/x?t=a&b=<script>');
		expect(msg.html).toContain('&lt;script&gt;');
		expect(msg.html).not.toContain('<script>');
	});
});

describe('sendSubmissionReceivedEmail', () => {
	it('returns skipped + unconfigured when the operator inbox is not configured', async () => {
		const r = await sendSubmissionReceivedEmail(makeQuote());
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('unconfigured');
		expect(queuedFiles()).toHaveLength(0);
	});

	it('enqueues one bilingual email to the customer with the operator CC and returns entry_id', async () => {
		configure();
		const r = await sendSubmissionReceivedEmail(makeQuote());
		expect(r.status).toBe('queued');
		expect(r.entry_id).toBeTruthy();
		const files = queuedFiles();
		expect(files).toHaveLength(1);
		const entry = files[0].entry as {
			to: string[];
			cc: string[];
			subject: string;
			body_text: string;
			submitter: string;
		};
		expect(entry.to).toEqual(['ada@example.com']);
		expect(entry.cc).toEqual(['ops@abenerp.com']);
		expect(entry.subject).toMatch(/Áben Consulting — Submission received, quote #/);
		expect(entry.body_text).toContain('Köszönjük az ajánlatkérést');
		expect(entry.body_text).toContain('Thank you for your quote request');
		expect(entry.body_text).toMatch(/\/q\/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\?t=/);
		expect(entry.submitter).toBe('submission_received');
	});
});

describe('sendAcceptedConfirmationEmail', () => {
	it('returns skipped + unconfigured when the operator inbox is not configured', async () => {
		const r = await sendAcceptedConfirmationEmail(makeQuote());
		expect(r.status).toBe('skipped');
		expect(r.reason).toBe('unconfigured');
	});

	it('enqueues the confirmation and returns the entry_id', async () => {
		configure();
		const r = await sendAcceptedConfirmationEmail(makeQuote());
		expect(r.status).toBe('queued');
		expect(r.entry_id).toBeTruthy();
		const files = queuedFiles();
		expect(files).toHaveLength(1);
		const entry = files[0].entry as {
			to: string[];
			cc: string[];
			subject: string;
			submitter: string;
		};
		expect(entry.to).toEqual(['ada@example.com']);
		expect(entry.cc).toEqual(['ops@abenerp.com']);
		expect(entry.subject).toContain('elfogadva');
		expect(entry.submitter).toBe('accept_confirmation');
	});
});

describe('rate-limit — per-(recipient, kind) cooldown (S285 F2, preserved through ADR-0009)', () => {
	it('submission-received does NOT block a subsequent priced-ready to the same recipient', async () => {
		configure();
		const first = await sendSubmissionReceivedEmail(makeQuote());
		expect(first.status).toBe('queued');
		const second = await sendPricedReadyEmail(
			makeQuote({
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
			})
		);
		expect(second.status).toBe('queued');
		expect(queuedFiles()).toHaveLength(2);
	});

	it('priced-ready does NOT block a subsequent accepted-confirmation to the same recipient', async () => {
		configure();
		const priced = await sendPricedReadyEmail(
			makeQuote({
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
			})
		);
		expect(priced.status).toBe('queued');
		const accepted = await sendAcceptedConfirmationEmail(makeQuote({ status: 'approved' }));
		expect(accepted.status).toBe('queued');
		expect(queuedFiles()).toHaveLength(2);
	});

	it('two submission-received emails to the SAME recipient within 60s still cool down', async () => {
		configure();
		const first = await sendSubmissionReceivedEmail(makeQuote());
		expect(first.status).toBe('queued');
		const second = await sendSubmissionReceivedEmail(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' })
		);
		expect(second.status).toBe('skipped');
		expect(second.reason).toBe('rate-limited');
	});
});
