<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>Imprint — ABENERP</title>
	<meta name="description" content="Legal imprint and operator information for abenerp.com." />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<main class="page">
	<div class="container">
		<header class="top">
			<a href={resolve('/')} class="back">← ABENERP</a>
			<h1>Imprint</h1>
			<p class="meta">Operator information / Impresszum</p>
		</header>

		<section>
			<h2>Operator</h2>
			<address>
				<strong>Áben Consulting Kft.</strong><br />
				Tax ID (Adószám): HU24904362-2-41<br />
				Registered address: 1037 Budapest, Visszatérő köz 6, Hungary<br />
				Email: <a href="mailto:contact@abenerp.com">contact@abenerp.com</a>
			</address>
		</section>

		<section>
			<h2>Registration</h2>
			<dl>
				<dt>Court of registration</dt>
				<dd class="placeholder">[to be confirmed before public launch]</dd>

				<dt>Company registration number (Cégjegyzékszám)</dt>
				<dd class="placeholder">[to be confirmed before public launch]</dd>

				<dt>Authorized representative (Képviselő)</dt>
				<dd class="placeholder">[to be confirmed before public launch]</dd>
			</dl>
		</section>

		<section>
			<h2>Contact</h2>
			<p>
				For all inquiries (commercial, technical, or legal) please email
				<a href="mailto:contact@abenerp.com">contact@abenerp.com</a>. We aim to respond within two
				business days.
			</p>
		</section>

		<section>
			<h2>Hosting</h2>
			<p>
				abenerp.com is served from Amazon Web Services. Static assets are stored in S3 (<code
					>eu-central-1</code
				>, Frankfurt) and delivered globally via Amazon CloudFront.
			</p>
		</section>

		<footer class="bottom">
			<a href={resolve('/')}>Home</a> · <a href={resolve('/privacy')}>Privacy</a>
		</footer>
	</div>
</main>

<style>
	.page {
		min-height: 100vh;
		min-height: 100dvh;
		background: #0f1320;
		color: #f3eee5;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		-webkit-font-smoothing: antialiased;
		padding: 3rem 1.5rem 4rem;
	}

	.container {
		max-width: 720px;
		margin: 0 auto;
		line-height: 1.65;
	}

	.top {
		margin-bottom: 2.5rem;
	}

	.back {
		display: inline-block;
		color: #d4a574;
		text-decoration: none;
		font-size: 0.875rem;
		letter-spacing: 0.05em;
		margin-bottom: 1.5rem;
	}

	.back:hover {
		text-decoration: underline;
	}

	h1 {
		font-size: clamp(1.75rem, 4vw, 2.5rem);
		font-weight: 600;
		margin: 0 0 0.5rem;
		letter-spacing: -0.01em;
	}

	.meta {
		color: rgba(243, 238, 229, 0.55);
		font-size: 0.875rem;
		margin: 0;
	}

	h2 {
		font-size: 1.125rem;
		font-weight: 600;
		margin: 2.25rem 0 0.75rem;
		color: #d4a574;
		letter-spacing: 0.02em;
	}

	section {
		margin-bottom: 0.5rem;
	}

	p {
		margin: 0 0 1rem;
	}

	address {
		font-style: normal;
		padding: 1rem 1.25rem;
		border-left: 2px solid #d4a574;
		background: rgba(212, 165, 116, 0.05);
	}

	dl {
		margin: 0;
	}

	dt {
		font-weight: 600;
		color: rgba(243, 238, 229, 0.85);
		margin-top: 1rem;
	}

	dd {
		margin: 0.25rem 0 0;
		padding-left: 0;
	}

	.placeholder {
		color: rgba(212, 165, 116, 0.7);
		font-style: italic;
		font-size: 0.95em;
	}

	a {
		color: #d4a574;
	}

	a:hover {
		color: #e2c089;
	}

	code {
		background: rgba(212, 165, 116, 0.12);
		padding: 0.1em 0.35em;
		border-radius: var(--radius-sm);
		font-size: 0.9em;
	}

	.bottom {
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid rgba(243, 238, 229, 0.1);
		font-size: 0.875rem;
		color: rgba(243, 238, 229, 0.55);
		text-align: center;
	}

	.bottom a {
		color: rgba(243, 238, 229, 0.7);
		text-decoration: none;
	}

	.bottom a:hover {
		color: #d4a574;
	}
</style>
