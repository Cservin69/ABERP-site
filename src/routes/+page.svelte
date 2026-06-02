<script lang="ts">
	import { resolve } from '$app/paths';
	import RainCanvas from '$lib/rain-effect/RainCanvas.svelte';
	import Wordmark from '$lib/brand/Wordmark.svelte';
</script>

<svelte:head>
	<title>ABENERP — custom manufacturing on demand</title>
	<meta
		name="description"
		content="ABENERP makes custom manufactured parts. Upload your CAD, get a quote, get it made."
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
		<a class="cta" href={resolve('/quote')}>Get a quote</a>
	</div>

	<nav class="footer-links" aria-label="Legal">
		<a href={resolve('/privacy')}>Privacy</a>
		<span class="sep" aria-hidden="true">·</span>
		<a href={resolve('/imprint')}>Imprint</a>
	</nav>
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
		color: #d8a753;
		margin-right: 0.35em;
	}

	.cta {
		display: inline-block;
		padding: 0.85rem 2.25rem;
		border: 1px solid #d8a753;
		color: #d8a753;
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
		background: #d8a753;
		color: #0f1320;
		outline: none;
	}

	.footer-links {
		position: absolute;
		bottom: 1.5rem;
		left: 0;
		right: 0;
		z-index: 1;
		text-align: center;
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		opacity: 0.6;
		transition: opacity 160ms ease;
		text-shadow: 0 1px 6px rgba(0, 0, 0, 0.55);
	}

	.footer-links:hover {
		opacity: 1;
	}

	.footer-links a {
		color: #f3eee5;
		text-decoration: none;
		padding: 0.25rem 0.4rem;
		border-bottom: 1px solid transparent;
		transition:
			color 160ms ease,
			border-color 160ms ease;
	}

	.footer-links a:hover,
	.footer-links a:focus-visible {
		color: #d8a753;
		border-bottom-color: #d8a753;
		outline: none;
	}

	.footer-links .sep {
		color: rgba(243, 238, 229, 0.5);
		margin: 0 0.25rem;
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
		.footer-links {
			bottom: 1rem;
		}
	}
</style>
