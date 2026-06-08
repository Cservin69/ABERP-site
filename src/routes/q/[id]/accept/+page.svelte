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
	// from an idempotent replay so we can show the same copy either way.
	const accepted = $derived(form?.accepted === true);
	const alreadyApproved = $derived(
		data.view === 'already-approved' || form?.alreadyApproved === true
	);
</script>

<svelte:head>
	<title>Ajánlat elfogadása {data.quote.shortId} — ABENERP</title>
	<meta name="robots" content="noindex, nofollow" />
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

		{#if accepted || alreadyApproved}
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
		border-radius: 2px;
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

	.stock-alert {
		padding: 0.75rem 0.9rem;
		border: 1px solid rgba(232, 188, 90, 0.55);
		background: rgba(232, 188, 90, 0.08);
		color: #f0d480;
		border-radius: 2px;
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
		border-radius: 2px;
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
		border-radius: 2px;
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
		border-radius: 2px;
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
</style>
