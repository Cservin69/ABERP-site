import { env } from '$env/dynamic/private';
import { readFile } from 'node:fs/promises';
import {
	EmailRelayError,
	isEmailRelayConfigured,
	sendEmailViaABERP,
	type EmailSendRequest,
	type EmailSendResponse
} from './email-relay';
import type { QuoteMetadata } from './quote-store';
import { pricedPdfPath } from './quote-store';
import { defaultAcceptExpiryIso, signAcceptToken, signQuoteToken } from './quote-token';
import { publicSiteUrl } from './public-url';

/**
 * Transactional email for quote notifications. SERVER-ONLY.
 *
 * PR-04 rewires this module from nodemailer/local SMTP onto the ABERP relay
 * endpoint (ADR-0007 supersedes ADR-0006). The exported function signatures
 * and HTML/text builders are preserved so callers (the /api/quote handler and
 * the priced-writeback handler) do not change shape.
 *
 * Design posture (preserved from PR-K, see [[trust-code-not-operator]]):
 *  - If the relay is not configured the module is a silent no-op. Quote
 *    submission and priced-writeback must never fail because email is
 *    unconfigured.
 *  - Sending is best-effort: a relay failure is logged and swallowed so it
 *    can never roll back a persisted quote or block a state transition.
 *  - Rate limiting + per-recipient cooldown stop a flood of submissions from
 *    turning into a flood of relay calls. The authoritative rate-limit lives
 *    on the ABERP side now; the storefront ceiling is a defensive secondary.
 *  - All user-controlled values are newline-stripped before they touch a
 *    header and HTML-escaped before they touch an HTML body. The /quote
 *    handler already rejects CR/LF/NUL, but this module does not trust that
 *    its one caller is the only caller.
 */

interface RelayConfig {
	operator: string;
	publicUrl: string;
}

function readConfig(): RelayConfig | null {
	if (!isEmailRelayConfigured()) return null;
	// The relay decides the sender identity (single SPF/DKIM lineage, ADR-0007).
	// The storefront still chooses where the *operator-side* alert mail lands.
	// `ABERP_SITE_OPERATOR_EMAIL` is the only fallback; if unset, operator alerts
	// are skipped so we never spam a stale SMTP_FROM mailbox the relay no longer
	// knows about. PR-04 dropped SMTP_FROM as a fallback — see ADR-0007.
	const operator = (env.ABERP_SITE_OPERATOR_EMAIL ?? '').trim();
	if (!operator) return null;
	return { operator, publicUrl: publicSiteUrl() };
}

/**
 * True when enough env is present to attempt a send via the ABERP relay AND a
 * canonical operator inbox is configured. Preserved as a boolean for caller
 * parity with the PR-K shape.
 */
export function isEmailConfigured(): boolean {
	return readConfig() !== null;
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

// --- Submission-received template (PR-07, bilingual HU+EN) ---------------
// Replaces the old English-only `buildCustomerEmail` send path for the
// /api/quote flow. The latter is preserved as a utility (and unit-tested as
// such) but is no longer called from the handler. Per the S284 walkthrough's
// OQ #4 and [[walkthrough-format]] expectations, the customer sees one
// bilingual message within ~10s of submit that links to the status page.

export function buildSubmissionReceivedEmail(
	q: QuoteMetadata,
	statusUrl: string
): QuoteEmailContent {
	const shortId = q.id.slice(0, 8);
	const subject = headerSafe(`Áben Consulting — Submission received, quote #${shortId}`);
	const text = [
		'Köszönjük az ajánlatkérést. Az ajánlat egy órán belül elkészül. Visszajelzünk e-mailben, amint elkészült.',
		`Hivatkozási szám: ${q.id}.`,
		`Időbélyeg: ${q.received_at}.`,
		`Az állapotot itt követheted: ${statusUrl}`,
		'',
		'---',
		'',
		"Thank you for your quote request. Your indicative quote will be ready within an hour. We'll email you as soon as it's done.",
		`Reference: ${q.id}.`,
		`Received at: ${q.received_at}.`,
		`Track your status: ${statusUrl}`,
		'',
		'— Áben Consulting'
	].join('\n');
	const html = [
		'<div style="font:14px system-ui,sans-serif;color:#222;max-width:560px">',
		'<h2 style="margin:0 0 16px;font:600 18px system-ui,sans-serif;color:#e8b84a">Áben Consulting</h2>',
		'<p style="margin:0 0 8px">Köszönjük az ajánlatkérést. Az ajánlat egy órán belül elkészül. Visszajelzünk e-mailben, amint elkészült.</p>',
		`<p style="margin:0 0 4px">Hivatkozási szám: <strong>${escapeHtml(q.id)}</strong>.</p>`,
		`<p style="margin:0 0 16px">Időbélyeg: ${escapeHtml(q.received_at)}.</p>`,
		`<p style="margin:0 0 24px"><a href="${escapeHtml(statusUrl)}" style="color:#e8b84a">Az állapotot itt követheted →</a></p>`,
		'<hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0">',
		'<p style="margin:0 0 8px">Thank you for your quote request. Your indicative quote will be ready within an hour. We\'ll email you as soon as it\'s done.</p>',
		`<p style="margin:0 0 4px">Reference: <strong>${escapeHtml(q.id)}</strong>.</p>`,
		`<p style="margin:0 0 16px">Received at: ${escapeHtml(q.received_at)}.</p>`,
		`<p style="margin:0 0 24px"><a href="${escapeHtml(statusUrl)}" style="color:#e8b84a">Track your status →</a></p>`,
		'<p style="margin:24px 0 0;color:#666">— Áben Consulting</p>',
		'</div>'
	].join('\n');
	return { subject, text, html };
}

export interface SubmissionReceivedResult {
	status: 'sent' | 'skipped' | 'failed';
	audit_id?: string;
	reason?: string;
}

/**
 * Sends the bilingual "submission received, pricing in progress" email to the
 * customer (with the operator CC'd so they get visibility without a dedicated
 * relay call). Wired via fire-and-forget from /api/quote so the customer's
 * 200 OK never blocks on the relay round-trip — per [[post-issue-async]] and
 * ADR-0007 §"Negative", relay outcome cannot affect the persisted quote.
 *
 * Like the rest of the module: never throws. The handler still wraps the
 * setImmediate body in a defensive `.catch` because contractual non-throwing
 * is one bug away from being a memory of one.
 */
export async function sendSubmissionReceivedEmail(
	q: QuoteMetadata
): Promise<SubmissionReceivedResult> {
	const cfg = readConfig();
	if (!cfg) {
		console.warn('[email] submission-received skipped: relay unconfigured');
		return { status: 'skipped', reason: 'unconfigured' };
	}
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	if (!tryReserve(customerEmail, Date.now())) {
		return { status: 'skipped', reason: 'rate-limited' };
	}
	const statusUrl = buildQuoteStatusUrl(q.id);
	const msg = buildSubmissionReceivedEmail(q, statusUrl);
	const res = await relaySendSafe({
		to: [customerEmail],
		cc: [cfg.operator],
		subject: msg.subject,
		body_text: msg.text,
		body_html: msg.html
	});
	if (!res) return { status: 'failed', reason: 'relay-failed' };
	return { status: 'sent', audit_id: res.audit_id };
}

// --- Priced-ready + accepted-confirmation templates ----------------------

export function buildPricedReadyEmail(q: QuoteMetadata, acceptUrl: string): QuoteEmailContent {
	const name = q.contact.name || 'there';
	const validUntil = q.pricing?.valid_until ?? '';
	const shortId = q.id.slice(0, 8);
	const subject = headerSafe(`Ajánlat ${shortId} — készen áll / Your quote is ready`);
	const text = [
		`Hi ${name},`,
		'',
		`Your quote ${q.id} is ready. The indicative PDF is attached to this email.`,
		validUntil ? `It is valid until ${validUntil}.` : '',
		'',
		'To accept this quote and start production, open the link below:',
		acceptUrl,
		'',
		'The link is valid for 30 days. If you do not accept by then, please reply to this email and we will re-issue.',
		'',
		'— The Áben Consulting team'
	]
		.filter((l) => l !== '')
		.join('\n');
	const html = [
		`<p style="font:14px system-ui,sans-serif;color:#222">Hi ${escapeHtml(name)},</p>`,
		`<p style="font:14px system-ui,sans-serif;color:#222">Your quote <strong>${escapeHtml(q.id)}</strong> is ready. The indicative PDF is attached.</p>`,
		validUntil
			? `<p style="font:14px system-ui,sans-serif;color:#222">It is valid until <strong>${escapeHtml(validUntil)}</strong>.</p>`
			: '',
		`<p style="font:14px system-ui,sans-serif;margin:24px 0"><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;padding:12px 24px;background:#d4a574;color:#0f1320;border-radius:2px;text-decoration:none;font-weight:600">Accept this quote →</a></p>`,
		'<p style="font:12px system-ui,sans-serif;color:#666">The accept link is valid for 30 days. After that, reply to this email and we will re-issue.</p>',
		'<p style="font:14px system-ui,sans-serif;color:#666">— The Áben Consulting team</p>'
	]
		.filter((l) => l !== '')
		.join('\n');
	return { subject, text, html };
}

export function buildAcceptedConfirmationEmail(q: QuoteMetadata): QuoteEmailContent {
	const name = q.contact.name || 'there';
	const shortId = q.id.slice(0, 8);
	const subject = headerSafe(`Ajánlat ${shortId} elfogadva / Your quote is accepted`);
	const text = [
		`Hi ${name},`,
		'',
		`Thank you for accepting quote ${q.id}. Our team will be in touch within two business days to confirm production scheduling.`,
		'',
		'If you have any questions in the meantime, reply to this email — please include your reference number.',
		'',
		'— The Áben Consulting team'
	].join('\n');
	const html = [
		`<p style="font:14px system-ui,sans-serif;color:#222">Hi ${escapeHtml(name)},</p>`,
		`<p style="font:14px system-ui,sans-serif;color:#222">Thank you for accepting quote <strong>${escapeHtml(q.id)}</strong>. Our team will be in touch within two business days to confirm production scheduling.</p>`,
		'<p style="font:14px system-ui,sans-serif;color:#222">If you have any questions in the meantime, reply to this email — please include your reference number.</p>',
		'<p style="font:14px system-ui,sans-serif;color:#666">— The Áben Consulting team</p>'
	].join('\n');
	return { subject, text, html };
}

// --- Send orchestration --------------------------------------------------
export interface NotifyResult {
	operator: 'sent' | 'skipped' | 'failed';
	customer: 'sent' | 'skipped' | 'failed';
	reason?: string;
}

async function relaySendSafe(req: EmailSendRequest): Promise<EmailSendResponse | null> {
	try {
		return await sendEmailViaABERP(req);
	} catch (err) {
		if (err instanceof EmailRelayError) {
			console.error(`[email] relay failed (${err.kind}, status=${err.status ?? 'n/a'})`);
		} else {
			console.error('[email] relay failed:', err);
		}
		return null;
	}
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

	const result: NotifyResult = { operator: 'skipped', customer: 'skipped' };
	const now = Date.now();

	// Operator notification.
	if (tryReserve(cfg.operator, now)) {
		const msg = buildOperatorEmail(q, cfg.publicUrl);
		const res = await relaySendSafe({
			to: [cfg.operator],
			subject: msg.subject,
			body_text: msg.text,
			body_html: msg.html
		});
		result.operator = res ? 'sent' : 'failed';
	} else {
		result.reason = 'rate-limited';
	}

	// Customer confirmation. The relay does not have a per-call reply-to knob —
	// the canonical sender on ABERP carries Reply-To at relay config time.
	const customerEmail = headerSafe(q.contact.email);
	if (customerEmail && tryReserve(customerEmail, Date.now())) {
		const msg = buildCustomerEmail(q);
		const res = await relaySendSafe({
			to: [customerEmail],
			cc: [cfg.operator],
			subject: msg.subject,
			body_text: msg.text,
			body_html: msg.html
		});
		result.customer = res ? 'sent' : 'failed';
	} else if (!customerEmail) {
		result.customer = 'skipped';
	} else {
		result.customer = 'skipped';
		result.reason = result.reason ?? 'rate-limited';
	}

	return result;
}

export interface PricedReadyResult {
	status: 'sent' | 'skipped' | 'failed';
	audit_id?: string;
	reason?: string;
}

/**
 * Sends the "your quote is ready" email with the indicative PDF attached and
 * the HMAC-signed accept link. Called from the priced-writeback handler after
 * a successful state flip into `quoted`.
 *
 * The accept link's `ts=` param is the 30-day-out ISO expiry per ADR-0005,
 * baked into both the URL and the HMAC input. The same expiry is the binding
 * one — verifyAcceptToken on the accept route must see the same string back.
 */
export async function sendPricedReadyEmail(q: QuoteMetadata): Promise<PricedReadyResult> {
	const cfg = readConfig();
	if (!cfg) return { status: 'skipped', reason: 'unconfigured' };
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	if (!tryReserve(customerEmail, Date.now())) {
		return { status: 'skipped', reason: 'rate-limited' };
	}

	const acceptUrl = buildAcceptUrl(q.id);
	const msg = buildPricedReadyEmail(q, acceptUrl);

	let attachments: EmailSendRequest['attachments'];
	const pdfPath = pricedPdfPath(q.id);
	if (pdfPath) {
		try {
			const bytes = await readFile(pdfPath);
			attachments = [
				{
					filename: 'quote.pdf',
					content_type: 'application/pdf',
					data_b64: bytes.toString('base64')
				}
			];
		} catch (err) {
			// Missing PDF is recoverable — the customer still gets the accept link.
			// The priced-writeback flow wrote the PDF *before* it called us, so a
			// read failure here means a disk / permissions issue, not a contract bug.
			console.error('[email] priced PDF read failed:', err);
		}
	}

	const res = await relaySendSafe({
		to: [customerEmail],
		cc: [cfg.operator],
		subject: msg.subject,
		body_text: msg.text,
		body_html: msg.html,
		attachments
	});
	if (!res) return { status: 'failed', reason: 'relay-failed' };
	return { status: 'sent', audit_id: res.audit_id };
}

export interface AcceptedConfirmationResult {
	status: 'sent' | 'skipped' | 'failed';
	audit_id?: string;
	reason?: string;
}

/**
 * Sends the "thank you, we received your acceptance" email. Called from the
 * customer accept POST after the state flips from `quoted → approved`.
 */
export async function sendAcceptedConfirmationEmail(
	q: QuoteMetadata
): Promise<AcceptedConfirmationResult> {
	const cfg = readConfig();
	if (!cfg) return { status: 'skipped', reason: 'unconfigured' };
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	if (!tryReserve(customerEmail, Date.now())) {
		return { status: 'skipped', reason: 'rate-limited' };
	}
	const msg = buildAcceptedConfirmationEmail(q);
	const res = await relaySendSafe({
		to: [customerEmail],
		cc: [cfg.operator],
		subject: msg.subject,
		body_text: msg.text,
		body_html: msg.html
	});
	if (!res) return { status: 'failed', reason: 'relay-failed' };
	return { status: 'sent', audit_id: res.audit_id };
}

// --- Customer-facing status URLs -----------------------------------------
// Single source of truth for customer-facing quote URLs and the confirmation
// subject. The confirmation send path above (sendQuoteNotifications) can import
// buildQuoteStatusUrl so the signed link is generated in exactly one place.
// The host comes from `publicSiteUrl()` — the same env var used by the operator
// admin-deep-link above (PR-Q reconciled the legacy URL/BASE_URL split).

/**
 * The read-only status page link for a quote, with its signed token attached:
 *   https://abenerp.com/q/<id>?t=<token>
 * Without the `?t=` token the route 404s, so this URL is the only way in.
 */
export function buildQuoteStatusUrl(id: string): string {
	const token = signQuoteToken(id);
	return `${publicSiteUrl()}/q/${encodeURIComponent(id)}?t=${token}`;
}

/**
 * The 30-day-expiring accept URL for a quote (ADR-0005):
 *   https://abenerp.com/q/<id>/accept?ts=<iso>&sig=<sig>
 * Issued at email-send time; the route handler re-verifies the signature and
 * checks `ts > now()` on every GET and POST.
 */
export function buildAcceptUrl(id: string): string {
	const expiryIso = defaultAcceptExpiryIso(Date.now());
	const sig = signAcceptToken(id, expiryIso);
	return `${publicSiteUrl()}/q/${encodeURIComponent(id)}/accept?ts=${encodeURIComponent(expiryIso)}&sig=${sig}`;
}

/** Subject line for the customer confirmation email — "Ajánlat visszaigazolás <short id>". */
export function quoteConfirmationSubject(id: string): string {
	return `Ajánlat visszaigazolás ${id.slice(0, 8)}`;
}
