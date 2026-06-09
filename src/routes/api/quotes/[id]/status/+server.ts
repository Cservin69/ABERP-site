import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdminAuth } from '$lib/server/auth';
import { readQuote, writeQuoteAtomic, type QuoteMetadata } from '$lib/server/quote-store';
import { isQuoteStatus, type QuoteStatus } from '$lib/server/quote-status';

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
