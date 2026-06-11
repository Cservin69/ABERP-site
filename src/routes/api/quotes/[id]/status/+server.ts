import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { readQuote, writeQuoteAtomic, type QuoteMetadata } from '$lib/server/quote-store';
import { isQuoteStatus, type QuoteStatus } from '$lib/server/quote-status';
import {
	isOperatorAcceptChannel,
	verifyOperatorAcceptSignature
} from '$lib/server/operator-accept';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- reject CR/LF/NUL injection in notes
const HEADER_INJECTION_RE = /[\r\n\x00]/;
const NOTES_MAX = 2000;

/**
 * State-machine guard for the Bearer-authenticated status writeback
 * (S285 finding F3 + F26 — was the single biggest correctness gap in the
 * S276–S284 arc). The pre-PR-09 handler accepted any value from
 * `QUOTE_STATUSES` and overwrote verbatim, so a buggy or compromised
 * ABERP-side bearer could move a quote `received → approved` directly,
 * defeating the typed-ACCEPT theater wholesale.
 *
 * Rules pinned to ADR-0004 §"State machine":
 *   - `quoting`  only from `received` or `quoting` (idempotent ABERP re-pull).
 *   - `quoted`   FORBIDDEN here — only POST /priced can set it (it carries
 *                the breakdown + PDF that make `quoted` meaningful).
 *   - `approved` FORBIDDEN here — only the customer accept POST can set it
 *                (typed-ACCEPT is the *only* path; ADR-0005's whole point).
 *   - `rejected` from any non-terminal state (operator-side decline).
 *   - `invoiced` only from `approved` (ABERP DEAL completion confirms the
 *                customer's prior consent).
 *
 * Terminal states (`approved` / `rejected` / `invoiced`) are an absorbing
 * barrier — no transition out is permitted on this handler. Idempotent
 * same-state writes (e.g. `quoting → quoting`) are accepted as no-ops so
 * an ABERP-side retry of the same writeback does not 409.
 */
const TERMINAL_STATES = new Set<QuoteStatus>(['approved', 'rejected', 'invoiced']);

type TransitionVerdict =
	| { ok: true; noop?: boolean }
	| { ok: false; status: 400 | 403 | 409; error: string };

function checkTransition(from: string, to: QuoteStatus): TransitionVerdict {
	// PR-10 / S297 F3 — idempotent same-state is a 200-noop on every
	// status, BEFORE the forbidden-target gates. The S295 design
	// correctly reserves `quoted` for POST /priced and `approved` for
	// the customer accept POST, but the forbidden-target check WAS
	// pre-empting `from === to` for those two states only — ABERP's
	// intake daemon re-polling `POST /status {status:'approved'}` on
	// an already-approved row received a hard 403 instead of a 200
	// noop. The semantics are "ABERP is forbidden from being
	// idempotent on the two states it most needs to be idempotent
	// on". The typed-ACCEPT gate is preserved because the only path
	// from `quoted → approved` is still the customer-accept POST;
	// allowing `approved → approved` here does NOT widen who can set
	// `approved` for the first time (S296 review F3).
	if (from === to) return { ok: true, noop: true };

	// `quoted` and `approved` are owned by other endpoints — refuse here
	// regardless of source state so the rule is independent of timing.
	if (to === 'quoted') {
		return {
			ok: false,
			status: 403,
			error: 'forbidden_transition: quoted is only settable by POST /priced'
		};
	}
	if (to === 'approved') {
		return {
			ok: false,
			status: 403,
			error: 'forbidden_transition: approved is only settable by the customer accept POST'
		};
	}

	// Terminal states are absorbing — once approved/rejected/invoiced, no
	// further transitions on this handler. `invoiced ← approved` is the one
	// legitimate handler-driven move and we allow it explicitly below;
	// everything else gates here.
	const isTerminal = (s: string): boolean => TERMINAL_STATES.has(s as QuoteStatus);

	if (to === 'quoting') {
		// `quoting → quoting` already returned noop at the top of this
		// fn (PR-10 / S297 F3); only `received → quoting` reaches here.
		if (from === 'received') return { ok: true };
		return {
			ok: false,
			status: 409,
			error: `forbidden_transition: ${from} → quoting (only received → quoting is allowed)`
		};
	}

	if (to === 'rejected') {
		if (!isTerminal(from)) return { ok: true };
		return {
			ok: false,
			status: 409,
			error: `forbidden_transition: ${from} → rejected (terminal states cannot transition)`
		};
	}

	if (to === 'invoiced') {
		if (from === 'approved') return { ok: true };
		return {
			ok: false,
			status: 409,
			error: `forbidden_transition: ${from} → invoiced (only approved → invoiced is allowed)`
		};
	}

	// `received` is only the initial state — never re-settable.
	if (to === 'received') {
		return {
			ok: false,
			status: 409,
			error: `forbidden_transition: ${from} → received (received is the initial state only)`
		};
	}

	// Unreachable: every QuoteStatus value is handled above. Defensive close.
	return { ok: false, status: 400, error: 'unhandled status value' };
}

export const POST: RequestHandler = async ({ params, request }) => {
	requireAdminAuth(request);

	const id = params.id ?? '';
	if (!UUID_RE.test(id)) return json({ error: 'Invalid id.' }, { status: 400 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body.' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') {
		return json({ error: 'Invalid body.' }, { status: 400 });
	}

	const { status, notes } = body as { status?: unknown; notes?: unknown };

	// S354 / ADR-0005 amendment — operator accept-on-behalf. A DISTINCT
	// transition from the customer-owned typed-ACCEPT: `operator_accepted`
	// is not a stored status (it is not in QUOTE_STATUSES), it is a signed
	// *intent* that, when the Bearer (already checked above) AND the HMAC
	// validate, advances a `quoted` quote to the same terminal `approved`
	// the customer accept reaches — tagged `accepted_via: 'operator'`. The
	// plain-Bearer `approved` below stays forbidden; only this signed path
	// may set `approved` operator-side.
	if (status === 'operator_accepted') {
		return handleOperatorAccept(id, body as Record<string, unknown>);
	}

	if (!isQuoteStatus(status)) {
		return json({ error: 'Invalid status value.' }, { status: 400 });
	}

	let notesStr = '';
	if (notes !== undefined && notes !== null) {
		if (typeof notes !== 'string')
			return json({ error: 'Notes must be a string.' }, { status: 400 });
		if (notes.length > NOTES_MAX) return json({ error: 'Notes too long.' }, { status: 400 });
		if (HEADER_INJECTION_RE.test(notes)) {
			return json({ error: 'Notes contains invalid characters.' }, { status: 400 });
		}
		notesStr = notes.trim();
	}

	const existing = await readQuote(id);
	if (!existing) return json({ error: 'Not found.' }, { status: 404 });

	const from = existing.status;
	const to = status;

	const verdict = checkTransition(from, to);
	if (!verdict.ok) {
		return json({ error: verdict.error, from, to }, { status: verdict.status });
	}
	if (verdict.noop) {
		// Idempotent ABERP re-pull — return the existing record unchanged so
		// the caller's retry semantics match the priced-writeback handler.
		return json(existing);
	}

	const updated: QuoteMetadata = {
		...existing,
		status: to,
		status_history: [
			...(existing.status_history ?? []),
			{ at: new Date().toISOString(), from, to, notes: notesStr }
		]
	};

	await writeQuoteAtomic(id, updated);
	return json(updated);
};

/**
 * S354 / ADR-0005 amendment — operator accept-on-behalf branch. Requires
 * (Bearer already validated by `requireAdminAuth` in POST) a valid HMAC
 * over `{id, channel, accepted_at_ms, operator_user_id}` keyed by the
 * Bearer secret. On success advances `quoted → approved` with
 * `accepted_via: 'operator'` and the operator audit fields. Refuses:
 *   - 400 malformed channel / note / operator_user_id / accepted_at_ms
 *   - 401 missing or invalid HMAC (refuses to accept without proof)
 *   - 404 unknown quote
 *   - 409 already `approved` (idempotency — including a customer accept
 *         that landed first) or any non-`quoted` source state
 */
async function handleOperatorAccept(id: string, body: Record<string, unknown>): Promise<Response> {
	const { channel, note, operator_user_id, accepted_at_ms, hmac_signature } = body;

	if (!isOperatorAcceptChannel(channel)) {
		return json({ error: 'Invalid channel.' }, { status: 400 });
	}
	if (typeof note !== 'string' || note.trim().length === 0) {
		return json({ error: 'Note is required.' }, { status: 400 });
	}
	if (note.length > NOTES_MAX) {
		return json({ error: 'Notes too long.' }, { status: 400 });
	}
	if (HEADER_INJECTION_RE.test(note)) {
		return json({ error: 'Notes contains invalid characters.' }, { status: 400 });
	}
	if (typeof operator_user_id !== 'string' || operator_user_id.trim().length === 0) {
		return json({ error: 'operator_user_id is required.' }, { status: 400 });
	}
	if (
		typeof accepted_at_ms !== 'number' ||
		!Number.isFinite(accepted_at_ms) ||
		!Number.isInteger(accepted_at_ms)
	) {
		return json({ error: 'accepted_at_ms must be an integer.' }, { status: 400 });
	}

	// HMAC is the proof of ABERP origin for this otherwise-forbidden
	// transition. A missing / malformed / mismatched signature is a flat
	// 401 — refuse to accept without proof.
	if (
		!verifyOperatorAcceptSignature(
			id,
			channel,
			accepted_at_ms,
			operator_user_id.trim(),
			hmac_signature
		)
	) {
		return json({ error: 'Invalid operator-accept signature.' }, { status: 401 });
	}

	const existing = await readQuote(id);
	if (!existing) return json({ error: 'Not found.' }, { status: 404 });

	// Idempotency: an already-approved quote (operator OR customer) is a
	// 409 — the accept already happened, ABERP surfaces it and does not
	// re-write.
	if (existing.status === 'approved') {
		return json(
			{ error: 'already_accepted', from: existing.status, to: 'approved' },
			{ status: 409 }
		);
	}
	// Operator-accept requires a priced quote — same precondition as the
	// customer accept link (which is only e-mailed once `quoted`).
	if (existing.status !== 'quoted') {
		return json(
			{
				error: `forbidden_transition: ${existing.status} → approved (operator-accept requires a quoted quote)`,
				from: existing.status,
				to: 'approved'
			},
			{ status: 409 }
		);
	}

	const now = new Date().toISOString();
	const trimmedNote = note.trim();
	const updated: QuoteMetadata = {
		...existing,
		status: 'approved',
		accepted_at: now,
		accepted_via: 'operator',
		operator_user_id: operator_user_id.trim(),
		operator_channel: channel,
		operator_note: trimmedNote,
		status_history: [
			...(existing.status_history ?? []),
			{
				at: now,
				from: existing.status,
				to: 'approved',
				notes: `Operator accept on behalf via ${channel}: ${trimmedNote}`
			}
		]
	};
	await writeQuoteAtomic(id, updated);
	return json(updated);
}
