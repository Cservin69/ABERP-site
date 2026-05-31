<script lang="ts">
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
	<!-- Rain WebGL canvas will mount here in Session 205 -->
	<div class="rain-placeholder" aria-hidden="true"></div>

	<div class="content">
		<h1 class="wordmark">FRIBOARD</h1>
		<p class="tagline">Your CAD. Your part. Made.</p>
		<a class="cta" href="mailto:{CONTACT_EMAIL}">Get a quote</a>
	</div>
</section>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: #0f1320;
		color: #e9e6df;
		font-family:
			'Inter',
			system-ui,
			-apple-system,
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

	.rain-placeholder {
		position: absolute;
		inset: 0;
		background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
		z-index: 0;
	}

	.content {
		position: relative;
		z-index: 1;
		text-align: center;
		padding: 2rem;
		max-width: 720px;
	}

	.wordmark {
		font-size: clamp(2.75rem, 9vw, 6rem);
		font-weight: 300;
		letter-spacing: 0.18em;
		margin: 0 0 1.25rem;
		color: #d4a574;
		text-transform: uppercase;
	}

	.tagline {
		font-size: clamp(1rem, 2.2vw, 1.35rem);
		font-weight: 300;
		letter-spacing: 0.04em;
		margin: 0 0 2.5rem;
		color: #cbc7bd;
	}

	.cta {
		display: inline-block;
		padding: 0.85rem 2.25rem;
		border: 1px solid #d4a574;
		color: #d4a574;
		text-decoration: none;
		font-size: 1rem;
		letter-spacing: 0.08em;
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
			margin-bottom: 2rem;
		}
		.cta {
			padding: 0.75rem 1.75rem;
		}
	}
</style>
