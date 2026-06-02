import { env } from '$env/dynamic/private';
import nodemailer, { type Transporter } from 'nodemailer';
import type { QuoteMetadata } from './quote-store';

/**
 * Transactional email for quote notifications. SERVER-ONLY.
 *
 * SMTP credentials are read at runtime via `$env/dynamic/private`, which
 * SvelteKit guarantees is never bundled into client-facing code. This module
 * must never be imported from a `.svelte` component or any `+page.ts` /
 * `+page.svelte` that runs in the browser — only from `+server.ts` /
 * `+page.server.ts` / other `$lib/server/*` modules.
 *
 * Design posture (see [[trust-code-not-operator]]):
 *  - If SMTP is not configured the module is a silent no-op. Quote submission
 *    must never fail because email is unconfigured (local dev, first deploy).
 *  - Sending is best-effort: a send failure is logged and swallowed so it can
 *    never roll back a persisted quote. A lost notification is recoverable
 *    (the quote is on disk and visible in /admin/quotes); a 500 on submit is not.
 *  - Rate limiting + per-recipient cooldown stop a flood of submissions (even
 *    valid ones, e.g. an attacker spamming a victim's address through our
 *    relay) from turning into a flood of mail.
 *  - All user-controlled values are newline-stripped before they touch a header
 *    and HTML-escaped before they touch an HTML body. Defense in depth: the
 *    /quote handler already rejects CR/LF/NUL, but this module does not trust
 *    that its one caller is the only caller.
 */

interface SmtpConfig {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	from: string;
	operator: string;
	publicUrl: string;
}

function readConfig(): SmtpConfig | null {
	const host = (env.SMTP_HOST ?? '').trim();
	const user = (env.SMTP_USER ?? '').trim();
	const pass = env.SMTP_PASS ?? '';
	const from = (env.SMTP_FROM ?? '').trim();
	// Minimum viable config. Without these we cannot authenticate or address mail.
	if (!host || !user || !pass || !from) return null;

	const portRaw = (env.SMTP_PORT ?? '').trim();
	const port = portRaw ? Number.parseInt(portRaw, 10) : 587;
	const secure = (env.SMTP_SECURE ?? '').trim().toLowerCase() === 'true';
	// Operator notifications fall back to the From address (self-notify) when no
	// dedicated inbox is configured.
	const operator = (env.ABERP_SITE_OPERATOR_EMAIL ?? '').trim() || from;
	const publicUrl = ((env.ABERP_SITE_PUBLIC_URL ?? '').trim() || 'https://abenerp.com').replace(
		/\/+$/,
		''
	);

	if (!Number.isFinite(port) || port < 1 || port > 65535) return null;

	return { host, port, secure, user, pass, from, operator, publicUrl };
}

/** True when enough SMTP env is present to attempt a send. */
export function isEmailConfigured(): boolean {
	return readConfig() !== null;
}

let cachedTransport: Transporter | null = null;
let cachedFor = '';

function getTransport(cfg: SmtpConfig): Transporter {
	// Key on the connection-defining fields so a config change rebuilds the pool.
	const key = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}`;
	if (cachedTransport && cachedFor === key) return cachedTransport;
	cachedTransport = nodemailer.createTransport({
		host: cfg.host,
		port: cfg.port,
		secure: cfg.secure,
		auth: { user: cfg.user, pass: cfg.pass }
	});
	cachedFor = key;
	return cachedTransport;
}

// --- Rate limiting -------------------------------------------------------
// Single-instance adapter-node deployment, so in-memory state is sufficient.
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 30; // messages per rolling minute across all recipients
const RECIPIENT_COOLDOWN_MS = 60_000; // min gap between two mails to one address

const globalSends: number[] = [];
const recipientLastSend = new Map<string, number>();

/** Exported for tests; resets all in-memory throttle state. */
export function __resetRateLimit(): void {
	globalSends.length = 0;
	recipientLastSend.clear();
	cachedTransport = null;
	cachedFor = '';
}

function pruneGlobal(now: number): void {
	while (globalSends.length > 0 && now - globalSends[0] > GLOBAL_WINDOW_MS) {
		globalSends.shift();
	}
}

/**
 * Reserves a send slot for `recipient`. Returns false (and reserves nothing)
 * when the global window is full or the recipient is in cooldown.
 */
function tryReserve(recipient: string, now: number): boolean {
	pruneGlobal(now);
	if (globalSends.length >= GLOBAL_MAX) return false;
	const last = recipientLastSend.get(recipient.toLowerCase());
	if (last !== undefined && now - last < RECIPIENT_COOLDOWN_MS) return false;
	globalSends.push(now);
	recipientLastSend.set(recipient.toLowerCase(), now);
	return true;
}

// --- Sanitization --------------------------------------------------------
/** Strip CR/LF/NUL so a value can never inject extra headers. */
function headerSafe(v: string): string {
	// eslint-disable-next-line no-control-regex -- strip CR/LF/NUL header-injection chars
	return v.replace(/[\r\n\x00]/g, ' ').trim();
}

function escapeHtml(v: string): string {
	return v
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// --- Message bodies ------------------------------------------------------
export interface QuoteEmailContent {
	subject: string;
	text: string;
	html: string;
}

function summaryLines(q: QuoteMetadata): string[] {
	const lines = [
		`Name: ${q.contact.name}`,
		`Email: ${q.contact.email}`,
		q.contact.company ? `Company: ${q.contact.company}` : null,
		`Material: ${q.request.material_preference}`,
		q.request.quantity !== null ? `Quantity: ${q.request.quantity}` : null,
		q.request.deadline ? `Deadline: ${q.request.deadline}` : null,
		`Files: ${q.files.length}`,
		q.request.notes ? `Notes: ${q.request.notes}` : null
	];
	return lines.filter((l): l is string => l !== null);
}

export function buildOperatorEmail(q: QuoteMetadata, publicUrl: string): QuoteEmailContent {
	const link = `${publicUrl}/admin/quotes/${q.id}`;
	const lines = summaryLines(q);
	const subject = headerSafe(`New quote request — ${q.contact.name || q.contact.email}`);
	const text = [
		'A new quote request was submitted on abenerp.com.',
		'',
		...lines,
		'',
		`Open in admin: ${link}`,
		`Quote ID: ${q.id}`
	].join('\n');
	const html = [
		'<h2 style="margin:0 0 12px;font:600 18px system-ui,sans-serif;color:#e8b84a">New quote request</h2>',
		'<table style="font:14px system-ui,sans-serif;color:#222;border-collapse:collapse">',
		...lines.map((l) => {
			const idx = l.indexOf(':');
			const label = escapeHtml(l.slice(0, idx));
			const value = escapeHtml(l.slice(idx + 1).trim());
			return `<tr><td style="padding:2px 12px 2px 0;color:#666">${label}</td><td style="padding:2px 0">${value}</td></tr>`;
		}),
		'</table>',
		`<p style="font:14px system-ui,sans-serif;margin:16px 0 4px"><a href="${escapeHtml(link)}" style="color:#e8b84a">Open in admin →</a></p>`,
		`<p style="font:12px system-ui,sans-serif;color:#999">Quote ID: ${escapeHtml(q.id)}</p>`
	].join('\n');
	return { subject, text, html };
}

export function buildCustomerEmail(q: QuoteMetadata): QuoteEmailContent {
	const name = q.contact.name || 'there';
	const subject = headerSafe('We received your quote request — ABENERP');
	const text = [
		`Hi ${name},`,
		'',
		'Thanks for sending us your CAD files — we have received your quote request and our team will review it shortly.',
		'',
		`Your reference number is ${q.id}.`,
		'',
		'We will be in touch with pricing. If you need to add anything, reply to this email and include your reference number.',
		'',
		'— The ABENERP team'
	].join('\n');
	const html = [
		`<p style="font:14px system-ui,sans-serif;color:#222">Hi ${escapeHtml(name)},</p>`,
		'<p style="font:14px system-ui,sans-serif;color:#222">Thanks for sending us your CAD files — we have received your quote request and our team will review it shortly.</p>',
		`<p style="font:14px system-ui,sans-serif;color:#222">Your reference number is <strong>${escapeHtml(q.id)}</strong>.</p>`,
		'<p style="font:14px system-ui,sans-serif;color:#222">We will be in touch with pricing. If you need to add anything, reply to this email and include your reference number.</p>',
		'<p style="font:14px system-ui,sans-serif;color:#666">— The ABENERP team</p>'
	].join('\n');
	return { subject, text, html };
}

// --- Send orchestration --------------------------------------------------
export interface NotifyResult {
	operator: 'sent' | 'skipped' | 'failed';
	customer: 'sent' | 'skipped' | 'failed';
	reason?: string;
}

/**
 * Sends the operator notification + customer confirmation for a freshly
 * submitted quote. Never throws — all failures are captured in the result.
 */
export async function sendQuoteNotifications(q: QuoteMetadata): Promise<NotifyResult> {
	const cfg = readConfig();
	if (!cfg) {
		return { operator: 'skipped', customer: 'skipped', reason: 'unconfigured' };
	}

	let transport: Transporter;
	try {
		transport = getTransport(cfg);
	} catch (err) {
		console.error('[email] transport init failed:', err);
		return { operator: 'failed', customer: 'failed', reason: 'transport-init' };
	}

	const now = Date.now();
	const result: NotifyResult = { operator: 'skipped', customer: 'skipped' };

	// Operator notification.
	if (tryReserve(cfg.operator, now)) {
		const msg = buildOperatorEmail(q, cfg.publicUrl);
		try {
			await transport.sendMail({
				from: cfg.from,
				to: cfg.operator,
				subject: msg.subject,
				text: msg.text,
				html: msg.html
			});
			result.operator = 'sent';
		} catch (err) {
			console.error('[email] operator notification failed:', err);
			result.operator = 'failed';
		}
	} else {
		result.reason = 'rate-limited';
	}

	// Customer confirmation. Reply-To points at the operator so replies reach a human.
	const customerEmail = headerSafe(q.contact.email);
	if (customerEmail && tryReserve(customerEmail, Date.now())) {
		const msg = buildCustomerEmail(q);
		try {
			await transport.sendMail({
				from: cfg.from,
				to: customerEmail,
				replyTo: cfg.operator,
				subject: msg.subject,
				text: msg.text,
				html: msg.html
			});
			result.customer = 'sent';
		} catch (err) {
			console.error('[email] customer confirmation failed:', err);
			result.customer = 'failed';
		}
	} else if (!customerEmail) {
		result.customer = 'skipped';
	} else {
		result.customer = 'skipped';
		result.reason = result.reason ?? 'rate-limited';
	}

	return result;
}
