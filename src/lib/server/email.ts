import { env } from '$env/dynamic/private';
import { readFile } from 'node:fs/promises';
import { enqueueEmail, type EmailEnqueueRequest, type EmailSubmitter } from './email-outbox';
import type { QuoteMetadata } from './quote-store';
import { pricedPdfPath } from './quote-store';
import { defaultAcceptExpiryIso, signAcceptToken, signQuoteToken } from './quote-token';
import { publicSiteUrl } from './public-url';
import { toleranceLabel } from '$lib/tolerance';

/**
 * Transactional email for quote notifications. SERVER-ONLY.
 *
 * PR-11 (ADR-0009) rewires this module from the push-based `email-relay.ts`
 * onto the pull-based `email-outbox.ts` queue. Outbound mail is no longer
 * POSTed to ABERP across a Cloudflare Tunnel — every send request lands on
 * disk as a queue entry and ABERP's existing 60s poll consumes the queue.
 *
 * The exported function signatures (`sendSubmissionReceivedEmail`,
 * `sendPricedReadyEmail`, `sendAcceptedConfirmationEmail`,
 * `sendQuoteNotifications`) are preserved; only the **status** discriminant
 * changes — `sent` becomes `queued` to reflect that the storefront cannot
 * synchronously prove the message went out the SMTP wire. `audit_id` is
 * dropped from the return shape because the audit lineage is set by ABERP
 * later, via `POST /api/internal/email-queue/{id}/sent`.
 *
 * Design posture (preserved from PR-K through PR-09):
 *  - If the operator inbox is not configured the module is a silent no-op.
 *    Quote submission, priced-writeback, and accept must never fail because
 *    the email path is unconfigured.
 *  - Enqueue is best-effort: a disk write failure is logged and swallowed so
 *    it can never roll back a persisted quote or block a state transition.
 *  - Rate limiting + per-recipient cooldown stop a flood of submissions from
 *    turning into a flood of queue entries. Now enforced storefront-side
 *    only (the relay-side ceiling that previously backed it is gone).
 *  - All user-controlled values are newline-stripped before they touch a
 *    header and HTML-escaped before they touch an HTML body. The /quote
 *    handler already rejects CR/LF/NUL, but this module does not trust that
 *    its one caller is the only caller.
 */

interface MailConfig {
	operator: string;
	publicUrl: string;
}

function readConfig(): MailConfig | null {
	// PR-11 / ADR-0009: the storefront no longer holds a relay base URL or
	// relay token. The only env knob it still needs is the operator inbox to
	// CC on customer mail. Without it, we skip silently so an under-configured
	// dev / smoke environment still serves /quote without 503ing.
	const operator = (env.ABERP_SITE_OPERATOR_EMAIL ?? '').trim();
	if (!operator) return null;
	return { operator, publicUrl: publicSiteUrl() };
}

/**
 * True when the operator inbox is configured. Preserved as a boolean for
 * caller parity with the PR-K shape — `false` means every send becomes a
 * no-op rather than throwing.
 */
export function isEmailConfigured(): boolean {
	return readConfig() !== null;
}

// --- Rate limiting -------------------------------------------------------
// Single-instance adapter-node deployment, so in-memory state is sufficient.
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX = 30;
const RECIPIENT_COOLDOWN_MS = 60_000;

/**
 * Message-kind tags used to scope the per-recipient cooldown. S285 F2: the
 * pre-PR-09 cooldown was per-recipient flat, which silently dropped the
 * priced-ready email whenever it landed within 60s of the submission-received
 * email — i.e. on every fast walkthrough. Tuple-scoping the cooldown stops
 * one legitimate-message-class from cannibalising another while still
 * defeating "press submit twelve times" floods on a single kind.
 */
export type EmailKind =
	| 'submission-received'
	| 'operator-notify'
	| 'priced-ready'
	| 'accepted-confirmation';

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

function cooldownKey(recipient: string, kind: EmailKind): string {
	return `${recipient.toLowerCase()}|${kind}`;
}

interface Reservation {
	release(): void;
}

function tryReserve(recipient: string, kind: EmailKind, now: number): Reservation | null {
	pruneGlobal(now);
	if (globalSends.length >= GLOBAL_MAX) return null;
	const key = cooldownKey(recipient, kind);
	const last = recipientLastSend.get(key);
	if (last !== undefined && now - last < RECIPIENT_COOLDOWN_MS) return null;
	globalSends.push(now);
	recipientLastSend.set(key, now);
	return {
		release(): void {
			for (let i = globalSends.length - 1; i >= 0; i--) {
				if (globalSends[i] === now) {
					globalSends.splice(i, 1);
					break;
				}
			}
			if (recipientLastSend.get(key) === now) {
				recipientLastSend.delete(key);
			}
		}
	};
}

// --- Sanitization --------------------------------------------------------
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
		`Tolerance: ${toleranceLabel(q.request.tolerance)}`,
		q.request.tolerance === 'per_drawing' || q.request.tolerance_critical
			? 'Tolerance review: MANUAL REVIEW (per-drawing and/or critical features flagged)'
			: null,
		q.request.quantity !== null ? `Quantity: ${q.request.quantity}` : null,
		q.request.deadline ? `Deadline: ${q.request.deadline}` : null,
		`Files: ${q.files.length}`,
		q.request.notes ? `Notes: ${q.request.notes}` : null,
		q.request.tolerance_note ? `Tolerance note: ${q.request.tolerance_note}` : null
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
		'Prices are quoted EXW (Ex Works, Incoterms 2020), Hungary — the price covers the manufactured part(s), made available and packed at our facility, ready for collection. Loading, transport, insurance, export/import clearance, customs duties and any taxes beyond Hungarian VAT are the buyer’s responsibility.',
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
		'<p style="font:12px system-ui,sans-serif;color:#666">Prices are quoted <strong>EXW (Ex Works, Incoterms 2020), Hungary</strong> — the price covers the manufactured part(s), made available and packed at our facility, ready for collection. Loading, transport, insurance, export/import clearance, customs duties and any taxes beyond Hungarian VAT are the buyer’s responsibility.</p>',
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

export type EmailDispatchStatus = 'queued' | 'skipped' | 'failed';

export interface EmailDispatchResult {
	status: EmailDispatchStatus;
	/** Queue entry id when `status === 'queued'`. */
	entry_id?: string;
	/** Reason discriminator: 'unconfigured' | 'no-recipient' | 'rate-limited' | 'enqueue-failed' */
	reason?: string;
}

export interface NotifyResult {
	operator: EmailDispatchStatus;
	customer: EmailDispatchStatus;
	reason?: string;
}

async function enqueueSafe(
	req: EmailEnqueueRequest,
	submitter: EmailSubmitter
): Promise<{ id: string } | null> {
	try {
		return await enqueueEmail(req, submitter);
	} catch (err) {
		console.error('[email] enqueue failed:', err);
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
	const opReservation = tryReserve(cfg.operator, 'operator-notify', now);
	if (opReservation) {
		const msg = buildOperatorEmail(q, cfg.publicUrl);
		const res = await enqueueSafe(
			{
				to: [cfg.operator],
				subject: msg.subject,
				body_text: msg.text,
				body_html: msg.html
			},
			'other'
		);
		if (res) {
			result.operator = 'queued';
		} else {
			opReservation.release();
			result.operator = 'failed';
		}
	} else {
		result.reason = 'rate-limited';
	}

	// Customer confirmation.
	const customerEmail = headerSafe(q.contact.email);
	const custReservation = customerEmail
		? tryReserve(customerEmail, 'submission-received', Date.now())
		: null;
	if (customerEmail && custReservation) {
		const msg = buildCustomerEmail(q);
		const res = await enqueueSafe(
			{
				to: [customerEmail],
				cc: [cfg.operator],
				subject: msg.subject,
				body_text: msg.text,
				body_html: msg.html
			},
			'submission_received'
		);
		if (res) {
			result.customer = 'queued';
		} else {
			custReservation.release();
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

/**
 * Sends the bilingual "submission received, pricing in progress" email to the
 * customer (operator CC'd). Wired via fire-and-forget from /api/quote so the
 * customer's 200 OK never blocks on the disk write — per [[post-issue-async]]
 * and ADR-0009 §"Consequences", enqueue outcome cannot affect the persisted
 * quote.
 */
export async function sendSubmissionReceivedEmail(q: QuoteMetadata): Promise<EmailDispatchResult> {
	const cfg = readConfig();
	if (!cfg) {
		console.warn('[email] submission-received skipped: operator inbox unconfigured');
		return { status: 'skipped', reason: 'unconfigured' };
	}
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	const reservation = tryReserve(customerEmail, 'submission-received', Date.now());
	if (!reservation) {
		return { status: 'skipped', reason: 'rate-limited' };
	}
	const statusUrl = buildQuoteStatusUrl(q.id);
	const msg = buildSubmissionReceivedEmail(q, statusUrl);
	const res = await enqueueSafe(
		{
			to: [customerEmail],
			cc: [cfg.operator],
			subject: msg.subject,
			body_text: msg.text,
			body_html: msg.html
		},
		'submission_received'
	);
	if (!res) {
		reservation.release();
		return { status: 'failed', reason: 'enqueue-failed' };
	}
	return { status: 'queued', entry_id: res.id };
}

/**
 * Sends the "your quote is ready" email with the indicative PDF attached and
 * the HMAC-signed accept link. Called from the priced-writeback handler after
 * a successful state flip into `quoted`.
 *
 * The accept link's `ts=` param is the 30-day-out ISO expiry per ADR-0005,
 * baked into both the URL and the HMAC input.
 */
export async function sendPricedReadyEmail(q: QuoteMetadata): Promise<EmailDispatchResult> {
	const cfg = readConfig();
	if (!cfg) return { status: 'skipped', reason: 'unconfigured' };
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	const reservation = tryReserve(customerEmail, 'priced-ready', Date.now());
	if (!reservation) {
		return { status: 'skipped', reason: 'rate-limited' };
	}

	const acceptUrl = buildAcceptUrl(q.id);
	const msg = buildPricedReadyEmail(q, acceptUrl);

	let attachments: EmailEnqueueRequest['attachments'];
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
			console.error('[email] priced PDF read failed:', err);
		}
	}

	const res = await enqueueSafe(
		{
			to: [customerEmail],
			cc: [cfg.operator],
			subject: msg.subject,
			body_text: msg.text,
			body_html: msg.html,
			attachments
		},
		'priced_ready'
	);
	if (!res) {
		reservation.release();
		return { status: 'failed', reason: 'enqueue-failed' };
	}
	return { status: 'queued', entry_id: res.id };
}

/**
 * Sends the "thank you, we received your acceptance" email. Called from the
 * customer accept POST after the state flips from `quoted → approved`.
 */
export async function sendAcceptedConfirmationEmail(
	q: QuoteMetadata
): Promise<EmailDispatchResult> {
	const cfg = readConfig();
	if (!cfg) return { status: 'skipped', reason: 'unconfigured' };
	const customerEmail = headerSafe(q.contact.email);
	if (!customerEmail) return { status: 'skipped', reason: 'no-recipient' };
	const reservation = tryReserve(customerEmail, 'accepted-confirmation', Date.now());
	if (!reservation) {
		return { status: 'skipped', reason: 'rate-limited' };
	}
	const msg = buildAcceptedConfirmationEmail(q);
	const res = await enqueueSafe(
		{
			to: [customerEmail],
			cc: [cfg.operator],
			subject: msg.subject,
			body_text: msg.text,
			body_html: msg.html
		},
		'accept_confirmation'
	);
	if (!res) {
		reservation.release();
		return { status: 'failed', reason: 'enqueue-failed' };
	}
	return { status: 'queued', entry_id: res.id };
}

// --- Customer-facing status URLs -----------------------------------------

/**
 * The read-only status page link for a quote, with its signed token attached:
 *   https://abenerp.com/q/<id>?t=<token>
 */
export function buildQuoteStatusUrl(id: string): string {
	const token = signQuoteToken(id);
	return `${publicSiteUrl()}/q/${encodeURIComponent(id)}?t=${token}`;
}

/**
 * The 30-day-expiring accept URL for a quote (ADR-0005):
 *   https://abenerp.com/q/<id>/accept?ts=<iso>&sig=<sig>
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
