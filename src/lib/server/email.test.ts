import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MailOpts {
	from: string;
	to: string;
	replyTo?: string;
	subject: string;
	text: string;
	html: string;
}

const { mockEnv, sendMail, createTransport } = vi.hoisted(() => {
	const sendMail = vi.fn(async (_opts: MailOpts) => ({ messageId: 'test' }));
	const createTransport = vi.fn(() => ({ sendMail }));
	return {
		mockEnv: {} as Record<string, string | undefined>,
		sendMail,
		createTransport
	};
});

vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import {
	isEmailConfigured,
	buildOperatorEmail,
	buildCustomerEmail,
	sendQuoteNotifications,
	__resetRateLimit
} from './email';
import type { QuoteMetadata } from './quote-store';

function configure(extra: Record<string, string> = {}): void {
	Object.assign(mockEnv, {
		SMTP_HOST: 'smtp.test',
		SMTP_USER: 'user',
		SMTP_PASS: 'pass',
		SMTP_FROM: 'ABENERP <quotes@abenerp.com>',
		ABERP_SITE_OPERATOR_EMAIL: 'ops@abenerp.com',
		ABERP_SITE_PUBLIC_URL: 'https://abenerp.com',
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

beforeEach(() => {
	clearEnv();
	__resetRateLimit();
	sendMail.mockClear();
	createTransport.mockClear();
	sendMail.mockImplementation(async () => ({ messageId: 'test' }));
});

describe('isEmailConfigured', () => {
	it('is false when no SMTP env is present', () => {
		expect(isEmailConfigured()).toBe(false);
	});

	it('is false when only some required vars are present', () => {
		Object.assign(mockEnv, { SMTP_HOST: 'smtp.test', SMTP_USER: 'user' });
		expect(isEmailConfigured()).toBe(false);
	});

	it('is true once host/user/pass/from are all set', () => {
		configure();
		expect(isEmailConfigured()).toBe(true);
	});

	it('is false when the port is out of range', () => {
		configure({ SMTP_PORT: '99999' });
		expect(isEmailConfigured()).toBe(false);
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

describe('sendQuoteNotifications', () => {
	it('is a no-op when SMTP is unconfigured', async () => {
		const res = await sendQuoteNotifications(makeQuote());
		expect(res).toEqual({ operator: 'skipped', customer: 'skipped', reason: 'unconfigured' });
		expect(createTransport).not.toHaveBeenCalled();
		expect(sendMail).not.toHaveBeenCalled();
	});

	it('sends operator + customer mail when configured', async () => {
		configure();
		const res = await sendQuoteNotifications(makeQuote());
		expect(res.operator).toBe('sent');
		expect(res.customer).toBe('sent');
		expect(sendMail).toHaveBeenCalledTimes(2);
		const recipients = sendMail.mock.calls.map((c) => c[0].to);
		expect(recipients).toContain('ops@abenerp.com');
		expect(recipients).toContain('ada@example.com');
	});

	it('sets a reply-to on the customer mail so replies reach the operator', async () => {
		configure();
		await sendQuoteNotifications(makeQuote());
		const customerCall = sendMail.mock.calls.find((c) => c[0].to === 'ada@example.com');
		expect(customerCall?.[0].replyTo).toBe('ops@abenerp.com');
	});

	it('does not throw and reports failure when the transport rejects', async () => {
		configure();
		sendMail.mockImplementation(async () => {
			throw new Error('SMTP 421');
		});
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
		// Same customer + same operator address, immediately again → both in cooldown.
		const second = await sendQuoteNotifications(
			makeQuote({ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' })
		);
		expect(second.operator).toBe('skipped');
		expect(second.customer).toBe('skipped');
		// Only the first submission's two mails went out.
		expect(sendMail).toHaveBeenCalledTimes(2);
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
		// With the global window saturated, late submissions stop sending.
		expect(lastCustomer).toBe('skipped');
	});

	it('uses SMTP_FROM as the operator address when no operator inbox is set', async () => {
		configure({ ABERP_SITE_OPERATOR_EMAIL: '' });
		await sendQuoteNotifications(makeQuote());
		const recipients = sendMail.mock.calls.map((c) => c[0].to);
		expect(recipients).toContain('ABENERP <quotes@abenerp.com>');
	});
});
