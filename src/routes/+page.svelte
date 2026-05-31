<script lang="ts">
	import RainCanvas from '$lib/rain-effect/RainCanvas.svelte';
	import Wordmark from '$lib/brand/Wordmark.svelte';

	const CONTACT_EMAIL = 'hello@friboard.com';
</script>

<svelte:head>
	<title>Friboard — custom manufacturing on demand</title>
	<meta
		name="description"
		content="Friboard makes custom manufactured parts. Upload your CAD, get a quote, get it made."
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<section class="hero">
	<RainCanvas />

	<div class="content">
		<h1 class="wordmark-wrap"><Wordmark /></h1>
		<p class="tagline">
			<span class="tag-accent">A —</span> Your CAD. Your part. Made.
		</p>
		<a class="cta" href="mailto:{CONTACT_EMAIL}">Get a quote</a>
	</div>
</section>

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

	.hero {
		position: relative;
		width: 100%;
		min-height: 100vh;
		min-height: 100dvh;
		display: grid;
		place-items: center;
		overflow: hidden;
	}

	.content {
		position: relative;
		z-index: 1;
		text-align: center;
		padding: 2rem;
		max-width: 760px;
		text-shadow: 0 2px 18px rgba(0, 0, 0, 0.55);
	}

	.wordmark-wrap {
		margin: 0 0 1.5rem;
	}

	.tagline {
		font-size: clamp(1rem, 2.2vw, 1.35rem);
		font-weight: 300;
		letter-spacing: 0.05em;
		margin: 0 0 2.5rem;
		color: #f3eee5;
	}

	.tag-accent {
		color: #d4a574;
		margin-right: 0.35em;
	}

	.cta {
		display: inline-block;
		padding: 0.85rem 2.25rem;
		border: 1px solid #d4a574;
		color: #d4a574;
		text-decoration: none;
		font-size: 1rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		background: transparent;
		transition:
			background-color 160ms ease,
			color 160ms ease;
	}

	.cta:hover,
	.cta:focus-visible {
		background: #d4a574;
		color: #0f1320;
		outline: none;
	}

	@media (max-width: 480px) {
		.content {
			padding: 1.25rem;
		}
		.tagline {
			margin: 1.25rem 0 2rem;
		}
		.cta {
			display: block;
			padding: 0.85rem 1rem;
		}
	}
</style>
