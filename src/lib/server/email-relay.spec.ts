import { describe, it, expect, beforeEach, vi } from 'vitest';

const { envState } = vi.hoisted(() => ({
	envState: {} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({
	env: new Proxy(envState as Record<string, string | undefined>, {
		get(target, prop: string) {
			return target[prop];
		}
	})
}));

import { isEmailRelayConfigured, sendEmailViaABERP, EmailRelayError } from './email-relay';

function configure(): void {
	envState.ABERP_INTERNAL_BASE_URL = 'https://aberp.example/';
	envState.ABERP_EMAIL_RELAY_TOKEN = 'unit-test-relay-token';
}

function clearEnv(): void {
	for (const k of Object.keys(envState)) delete envState[k];
}

const fetchMock = vi.fn();
beforeEach(() => {
	clearEnv();
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

describe('isEmailRelayConfigured', () => {
	it('is false without both base URL and bearer token', () => {
		expect(isEmailRelayConfigured()).toBe(false);
		envState.ABERP_INTERNAL_BASE_URL = 'https://aberp.example';
		expect(isEmailRelayConfigured()).toBe(false);
	});
	it('is true with both env vars present', () => {
		configure();
		expect(isEmailRelayConfigured()).toBe(true);
	});
});

describe('sendEmailViaABERP', () => {
	it('throws unconfigured when env vars are missing', async () => {
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'unconfigured' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('POSTs to /api/internal/send-email with bearer auth and JSON body', async () => {
		configure();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ audit_id: 'evt_42' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		const res = await sendEmailViaABERP({
			to: ['ada@example.com'],
			cc: ['ops@aberp.example'],
			subject: 'hi',
			body_text: 'plain',
			body_html: '<p>html</p>',
			attachments: [{ filename: 'q.pdf', content_type: 'application/pdf', data_b64: 'AAAA' }]
		});
		expect(res.audit_id).toBe('evt_42');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		// Trailing slashes on the base URL are stripped before path is appended.
		expect(url).toBe('https://aberp.example/api/internal/send-email');
		expect((init as RequestInit).method).toBe('POST');
		const headers = (init as RequestInit).headers as Record<string, string>;
		expect(headers['Authorization']).toBe('Bearer unit-test-relay-token');
		expect(headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(String((init as RequestInit).body));
		expect(body.to).toEqual(['ada@example.com']);
		expect(body.cc).toEqual(['ops@aberp.example']);
		expect(body.attachments[0].data_b64).toBe('AAAA');
	});

	it('maps 401 → unauthorized', async () => {
		configure();
		fetchMock.mockResolvedValue(new Response('', { status: 401 }));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
	});

	it('maps 400 → bad_request', async () => {
		configure();
		fetchMock.mockResolvedValue(new Response('', { status: 400 }));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'bad_request' });
	});

	it('maps 413 → too_large', async () => {
		configure();
		fetchMock.mockResolvedValue(new Response('', { status: 413 }));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'too_large' });
	});

	it('maps 429 → rate_limited', async () => {
		configure();
		fetchMock.mockResolvedValue(new Response('', { status: 429 }));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'rate_limited' });
	});

	it('maps 503 → unavailable', async () => {
		configure();
		fetchMock.mockResolvedValue(new Response('', { status: 503 }));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'unavailable' });
	});

	it('maps network failure → network', async () => {
		configure();
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toBeInstanceOf(EmailRelayError);
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'network' });
	});

	it('maps 200 without an audit_id field → malformed_response', async () => {
		configure();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		await expect(
			sendEmailViaABERP({ to: ['a@b.co'], subject: 's', body_text: 't' })
		).rejects.toMatchObject({ kind: 'malformed_response' });
	});
});
