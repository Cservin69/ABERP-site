<script lang="ts">
	import Wordmark from '$lib/brand/Wordmark.svelte';

	let { data } = $props();

	const shortId = $derived(data.quote.id.slice(0, 8));

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copyId() {
		try {
			await navigator.clipboard.writeText(data.quote.id);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1800);
		} catch {
			copied = false;
		}
	}

	function formatDate(iso: string): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
	}
</script>

<svelte:head>
	<title>Ajánlat {shortId} — ABENERP</title>
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
				<button class="id" type="button" onclick={copyId} title="Másolás / Copy">
					{shortId}…
					<span class="copyhint">{copied ? '✓ másolva' : 'kattints a másoláshoz'}</span>
				</button>
			</div>
			<span class="chip status-{data.quote.status}">
				{data.quote.statusLabel.hu} · {data.quote.statusLabel.en}
			</span>
		</header>

		<section class="block ownership">
			<p>
				Ez a(z) <strong>{data.quote.contact.name}</strong> nevére, a
				<strong>{data.quote.contact.email}</strong> címre beérkezett ajánlatkérés állapota.
			</p>
			<p class="en">
				Status of the quote request received for <strong>{data.quote.contact.name}</strong>
				({data.quote.contact.email}).
			</p>
		</section>

		<section class="block dates">
			<dl>
				<dt>Beérkezett / Submitted on</dt>
				<dd>{formatDate(data.quote.received_at)}</dd>
				{#if data.expectedResponseBy}
					<dt>Várható válasz / Expected response by</dt>
					<dd>{formatDate(data.expectedResponseBy)}</dd>
				{/if}
			</dl>
		</section>

		<section class="block history">
			<h2>Állapotelőzmény / Status timeline</h2>
			<ol>
				<li>
					<span class="ts">{formatDate(data.quote.received_at)}</span>
					<span class="transition">
						beérkezett → <strong
							>{data.quote.receivedLabel.hu} · {data.quote.receivedLabel.en}</strong
						>
					</span>
				</li>
				{#each data.quote.history as h, idx (idx)}
					<li>
						<span class="ts">{formatDate(h.at)}</span>
						<span class="transition">
							{h.fromLabel.en} → <strong>{h.toLabel.hu} · {h.toLabel.en}</strong>
						</span>
					</li>
				{/each}
			</ol>
		</section>

		<footer class="foot">
			<p>
				Módosítanál valamit? Válaszolj a visszaigazoló e-mailre, vagy írj ide:
				<a href="mailto:confirmation@abenerp.com">confirmation@abenerp.com</a>.
			</p>
			<p class="en">
				Need to change something? Reply to the confirmation email, or write to
				<a href="mailto:confirmation@abenerp.com">confirmation@abenerp.com</a>.
			</p>
		</footer>
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
		display: inline-flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0;
		border: none;
		background: none;
		color: #f3eee5;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.3rem;
		cursor: pointer;
	}

	.copyhint {
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		font-size: 0.72rem;
		color: rgba(243, 238, 229, 0.45);
	}

	.id:hover .copyhint {
		color: #d4a574;
	}

	.block {
		padding: 1.1rem 1.25rem;
		border: 1px solid rgba(212, 165, 116, 0.18);
		background: rgba(255, 255, 255, 0.02);
		border-radius: 2px;
		margin-bottom: 1.25rem;
	}

	.ownership p {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
		line-height: 1.5;
	}

	.ownership p:last-child {
		margin-bottom: 0;
	}

	.en {
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.85rem !important;
	}

	dl {
		margin: 0;
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

	h2 {
		margin: 0 0 0.85rem;
		font-size: 0.74rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: rgba(243, 238, 229, 0.55);
	}

	.history ol {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.history li {
		padding: 0.55rem 0.75rem;
		background: rgba(255, 255, 255, 0.03);
		border-left: 2px solid rgba(212, 165, 116, 0.35);
		font-size: 0.85rem;
	}

	.ts {
		color: rgba(243, 238, 229, 0.55);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.76rem;
		margin-right: 0.75rem;
	}

	.foot {
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px solid rgba(212, 165, 116, 0.18);
	}

	.foot p {
		margin: 0 0 0.4rem;
		font-size: 0.85rem;
		color: rgba(243, 238, 229, 0.75);
		line-height: 1.5;
	}

	.foot a {
		color: #d4a574;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		padding: 0.4rem 0.95rem;
		border-radius: 999px;
		font-size: 0.85rem;
		letter-spacing: 0.04em;
	}

	.chip.status-received {
		background: rgba(160, 160, 160, 0.16);
		color: #d6d6d6;
	}
	.chip.status-quoting {
		background: rgba(232, 188, 90, 0.16);
		color: #f0d480;
	}
	.chip.status-quoted {
		background: rgba(94, 156, 211, 0.16);
		color: #88c0e8;
	}
	.chip.status-approved {
		background: rgba(120, 184, 120, 0.16);
		color: #9fd49f;
	}
	.chip.status-rejected {
		background: rgba(198, 106, 106, 0.16);
		color: #e8a8a8;
	}
	.chip.status-invoiced {
		background: rgba(170, 124, 196, 0.18);
		color: #c9a8e0;
	}
</style>
