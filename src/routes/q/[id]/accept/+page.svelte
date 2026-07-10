<script lang="ts">
	import Wordmark from '$lib/brand/Wordmark.svelte';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	let typed = $state('');
	let submitting = $state(false);

	const matched = $derived(typed === (data.view === 'confirm' ? data.acceptToken : ''));
	const empty = $derived(typed.length === 0);

	// Once the action returns `accepted`, the visual switches to the thank-you
	// state regardless of whether the load returned `confirm` or
	// `already-approved`. `form?.alreadyApproved` distinguishes a fresh accept
	// from an idempotent replay so we show the right copy either way.
	const accepted = $derived(form?.accepted === true);
	const alreadyApproved = $derived(
		data.view === 'already-approved' || form?.alreadyApproved === true
	);

	// The already-accepted surface (Bug #7) shows *when* it was accepted, the
	// current ledger status, and a link back to the full timeline. These come
	// from the action result on a replayed POST, else from the load on a
	// re-clicked link. Labels are resolved server-side ($lib/server/quote-status
	// can't be imported here).
	const acceptedAt = $derived(
		form?.acceptedAt ?? (data.view === 'already-approved' ? data.acceptedAt : null)
	);
	const statusLabel = $derived(
		form?.statusLabel ?? (data.view === 'already-approved' ? data.quote.statusLabel : null)
	);
	const statusUrl = $derived(
		form?.statusUrl ?? (data.view === 'already-approved' ? data.statusUrl : null)
	);

	function formatDate(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
	}

	// Inline "when" fragments built in script so the markup stays free of
	// string-literal mustaches (svelte/no-useless-mustaches). Empty when the
	// acceptance timestamp is unknown.
	const acceptedAtHu = $derived(acceptedAt ? ` (${formatDate(acceptedAt)})` : '');
	const acceptedAtEn = $derived(acceptedAt ? ` on ${formatDate(acceptedAt)}` : '');
</script>

<svelte:head>
	<title>Ajánlat elfogadása {data.quote.shortId} — ABENERP</title>
	<meta name="robots" content="noindex, nofollow, noarchive, nocache, noimageindex" />
</svelte:head>

<main class="page">
	<div class="container">
		<div class="wordmark-wrap">
			<Wordmark size={0.5} showMonogram={false} />
		</div>

		<header class="head">
			<div class="idline">
				<span class="idlabel">Ajánlat / Quote</span>
				<span class="id">{data.quote.shortId}…</span>
			</div>
		</header>

		{#if alreadyApproved}
			<section class="block accepted">
				<h2>Már elfogadva / Already accepted</h2>
				<p>
					Ezt az ajánlatot <strong>már elfogadtad</strong>{acceptedAtHu}. Nincs további teendőd — a
					megrendelés feldolgozása folyamatban van.
				</p>
				<p class="en">
					This quote was <strong>already accepted</strong>{acceptedAtEn}. Nothing more to do — your
					order is being processed.
				</p>
				{#if statusLabel}
					<p class="hint">
						Az ajánlat státusza / Current status:
						<strong>{statusLabel.hu} · {statusLabel.en}</strong>
					</p>
				{/if}
				{#if statusUrl}
					<p class="status-link-wrap">
						<a class="status-link" href={statusUrl}>Állapot megtekintése / View status timeline →</a
						>
					</p>
				{/if}
			</section>
		{:else if accepted}
			<section class="block accepted">
				<h2>Elfogadva / Accepted</h2>
				<p>
					Köszönjük! Az ajánlatot <strong>elfogadottnak</strong> rögzítettük. Csapatunk két munkanapon
					belül felveszi veled a kapcsolatot a gyártás ütemezésével kapcsolatban.
				</p>
				<p class="en">
					Thank you. Your quote <strong>{data.quote.id}</strong> is now marked
					<strong>accepted</strong>. Our team will be in touch within two business days to confirm
					production scheduling.
				</p>
				<p class="hint">
					Visszaigazoló e-mailt is küldtünk a {data.quote.contact.email} címre. / A confirmation email
					has been sent to {data.quote.contact.email}.
				</p>
				{#if statusUrl}
					<p class="status-link-wrap">
						<a class="status-link" href={statusUrl}>Állapot megtekintése / View status timeline →</a
						>
					</p>
				{/if}
			</section>
		{:else if data.view === 'confirm'}
			<section class="block ownership">
				<p>
					Ezt az ajánlatot a(z) <strong>{data.quote.contact.name}</strong> nevére, a
					<strong>{data.quote.contact.email}</strong> címre küldtük el.
				</p>
				<p class="en">
					This quote was issued to <strong>{data.quote.contact.name}</strong>
					({data.quote.contact.email}).
				</p>
			</section>

			{#if data.quote.pricing}
				<section class="block summary">
					<dl>
						<dt>Érvényes / Valid until</dt>
						<dd>{data.quote.pricing.valid_until}</dd>
					</dl>
					{#if data.quote.pricing.stock_alert}
						<p class="stock-alert" role="alert">
							<strong>Anyag-készlet változott / Stock status changed</strong> — az árajánlat
							frissülhet, ha {data.quote.pricing.valid_until} előtt nem fogadod el. Stock status changed
							since this quote was issued — pricing may be refreshed if not accepted by
							{data.quote.pricing.valid_until}.
						</p>
					{/if}
				</section>
			{/if}

			<section class="block confirm" aria-label="Accept confirmation">
				<h2>Megerősítés / Confirm acceptance</h2>
				<p>
					Az ajánlat elfogadása <strong>kötelező érvényű</strong> — gépeljük be a megerősítő szót, hogy
					biztosak legyünk benne.
				</p>
				<p class="en">
					Accepting this quote is a <strong>binding commitment</strong>. To make sure, type the
					confirmation word below.
				</p>

				<form
					method="POST"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update({ reset: false });
							submitting = false;
						};
					}}
				>
					<label for="accept_token" class="big-label">
						Type <code>{data.acceptToken}</code> to confirm:
					</label>
					<input
						id="accept_token"
						name="accept_token"
						type="text"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						class="big-input"
						class:empty
						class:matched
						class:mismatch={!empty && !matched}
						placeholder={data.acceptToken}
						bind:value={typed}
						required
					/>

					{#if form?.error}
						<p class="error" role="alert">{form.error}</p>
					{/if}

					<button
						type="submit"
						class="big-button"
						class:armed={matched}
						disabled={!matched || submitting}
					>
						{#if submitting}
							Folyamatban… / Submitting…
						{:else}
							Elfogadom — accept this quote
						{/if}
					</button>
				</form>

				<p class="terms">
					Az elfogadással beleegyezel az indikatív árajánlat feltételeibe. Az elfogadás egyszeri
					művelet — utána a megrendelés feldolgozása megkezdődik.
				</p>
				<p class="terms en">
					By accepting, you agree to the indicative quote's terms. Acceptance is a one-time action —
					order processing begins immediately after.
				</p>
			</section>
		{/if}
	</div>
</main>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: #0f1320;
		color: #f3eee5;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		-webkit-font-smoothing: antialiased;
	}

	.page {
		min-height: 100vh;
		min-height: 100dvh;
		padding: 2rem 1rem 4rem;
	}

	.container {
		max-width: 640px;
		margin: 0 auto;
	}

	.wordmark-wrap {
		margin: 0 0 2rem;
		max-width: 280px;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1.5rem;
		margin: 0 0 1.5rem;
		flex-wrap: wrap;
	}

	.idline {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.idlabel {
		font-size: 0.72rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(243, 238, 229, 0.55);
	}

	.id {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.3rem;
	}

	.block {
		padding: 1.25rem 1.4rem;
		border: 1px solid rgba(212, 165, 116, 0.18);
		background: rgba(255, 255, 255, 0.02);
		border-radius: var(--radius-sm);
		margin-bottom: 1.25rem;
	}

	h2 {
		margin: 0 0 0.85rem;
		font-size: 0.74rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: rgba(243, 238, 229, 0.55);
	}

	.ownership p,
	.summary p,
	.confirm p {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
		line-height: 1.5;
	}

	.ownership p:last-child,
	.summary p:last-child,
	.confirm p:last-child {
		margin-bottom: 0;
	}

	.en {
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.85rem !important;
	}

	dl {
		margin: 0 0 0.75rem;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.5rem 1.25rem;
		font-size: 0.9rem;
	}

	dt {
		color: rgba(243, 238, 229, 0.55);
		font-size: 0.72rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding-top: 0.15rem;
	}

	dd {
		margin: 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.85rem;
	}

	/* Addendum-2 "BIG/RED" stock-alert (S285 F9). Reuses #c66a6a — the same
	   red the big-input border uses on empty/mismatch — so it reads as a
	   single storefront red, not a new palette entry. */
	.stock-alert {
		padding: 0.75rem 0.9rem;
		border: 1px solid rgba(198, 106, 106, 0.55);
		background: rgba(198, 106, 106, 0.08);
		color: #e8a8a8;
		border-radius: var(--radius-sm);
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.confirm {
		border-color: rgba(212, 165, 116, 0.35);
	}

	.big-label {
		display: block;
		margin: 1.25rem 0 0.6rem;
		font-size: 1.05rem;
		font-weight: 500;
	}

	.big-label code {
		background: rgba(212, 165, 116, 0.18);
		border: 1px solid rgba(212, 165, 116, 0.55);
		padding: 0.1rem 0.5rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.05rem;
		color: #f3eee5;
		border-radius: var(--radius-sm);
	}

	/* RED border when empty, RED+shake-ish hint when filled but mismatched,
	   GREEN border when matched. Mirrors operator-side DEAL/STORNO posture. */
	.big-input {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 1rem 1.1rem;
		margin: 0 0 1rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.5rem;
		text-align: center;
		letter-spacing: 0.15em;
		background: rgba(15, 19, 32, 0.9);
		color: #f3eee5;
		border: 3px solid #c66a6a;
		border-radius: var(--radius-sm);
		outline: none;
		transition:
			border-color 120ms ease-out,
			background 120ms ease-out;
	}

	.big-input.empty {
		border-color: #c66a6a;
	}

	.big-input.mismatch {
		border-color: #c66a6a;
		background: rgba(198, 106, 106, 0.08);
	}

	.big-input.matched {
		border-color: #78b878;
		background: rgba(120, 184, 120, 0.08);
	}

	.big-input:focus {
		box-shadow: 0 0 0 2px rgba(212, 165, 116, 0.25);
	}

	.big-button {
		display: block;
		width: 100%;
		box-sizing: border-box;
		padding: 1rem 1.1rem;
		font-size: 1.05rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		background: rgba(212, 165, 116, 0.15);
		color: rgba(243, 238, 229, 0.5);
		border: 2px solid rgba(212, 165, 116, 0.35);
		border-radius: var(--radius-sm);
		cursor: not-allowed;
		transition:
			background 120ms ease-out,
			border-color 120ms ease-out,
			color 120ms ease-out;
	}

	.big-button.armed:not([disabled]) {
		background: #78b878;
		color: #0f1320;
		border-color: #78b878;
		cursor: pointer;
	}

	.big-button.armed:not([disabled]):hover {
		background: #8cc88c;
	}

	.error {
		margin: 0.5rem 0 1rem !important;
		color: #e8a8a8;
		font-size: 0.9rem !important;
	}

	.terms {
		margin: 1.25rem 0 0 !important;
		font-size: 0.8rem !important;
		color: rgba(243, 238, 229, 0.55);
		line-height: 1.5;
	}

	.accepted h2 {
		color: #9fd49f;
	}

	.accepted {
		border-color: rgba(120, 184, 120, 0.55);
		background: rgba(120, 184, 120, 0.06);
	}

	.accepted p {
		margin: 0 0 0.6rem;
		font-size: 0.95rem;
		line-height: 1.5;
	}

	.accepted .hint {
		margin: 1rem 0 0;
		font-size: 0.82rem;
		color: rgba(243, 238, 229, 0.6);
	}

	.status-link-wrap {
		margin: 1.1rem 0 0;
	}

	.status-link {
		display: inline-block;
		padding: 0.55rem 0.95rem;
		border: 1px solid rgba(212, 165, 116, 0.55);
		border-radius: var(--radius-sm);
		color: #f3eee5;
		text-decoration: none;
		font-size: 0.9rem;
		background: rgba(212, 165, 116, 0.1);
	}

	.status-link:hover {
		background: rgba(212, 165, 116, 0.2);
		color: #d4a574;
	}
</style>
