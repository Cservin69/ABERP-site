<script lang="ts">
	import { page } from '$app/state';
	import Wordmark from '$lib/brand/Wordmark.svelte';
</script>

<svelte:head>
	<title>Ajánlat nem található — ABENERP</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="page">
	<div class="container">
		<div class="wordmark-wrap">
			<Wordmark size={0.5} showMonogram={false} />
		</div>
		<h1>Az ajánlat nem található</h1>
		<p>
			A link érvénytelen vagy lejárt. Ellenőrizd, hogy a teljes hivatkozást nyitottad-e meg a
			visszaigazoló e-mailből.
		</p>
		<p class="en">
			This link is invalid or expired ({page.status}). Please open the complete link from your
			confirmation email.
		</p>
		<p class="contact">
			Segítségre van szükséged? / Need help?
			<a href="mailto:confirmation@abenerp.com">confirmation@abenerp.com</a>
		</p>
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
		max-width: 560px;
		margin: 0 auto;
	}

	.wordmark-wrap {
		margin: 0 0 2rem;
		max-width: 280px;
	}

	h1 {
		margin: 0 0 0.75rem;
		font-size: clamp(1.4rem, 4vw, 2rem);
		font-weight: 400;
		letter-spacing: 0.02em;
	}

	p {
		margin: 0 0 0.6rem;
		line-height: 1.5;
		color: rgba(243, 238, 229, 0.85);
	}

	.en {
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.9rem;
	}

	.contact {
		margin-top: 1.5rem;
		font-size: 0.9rem;
	}

	.contact a {
		color: #d4a574;
	}
</style>
