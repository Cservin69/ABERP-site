<script lang="ts">
	import { resolve } from '$app/paths';
</script>

<svelte:head>
	<title>Privacy — ABENERP</title>
	<meta
		name="description"
		content="Privacy policy for abenerp.com. No cookies, no analytics, no third-party tracking."
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<main class="page">
	<div class="container">
		<header class="top">
			<a href={resolve('/')} class="back">← ABENERP</a>
			<h1>Privacy policy</h1>
			<p class="meta">Last reviewed: 2026-05-31</p>
		</header>

		<section>
			<h2>Summary</h2>
			<p>
				<strong
					>This site sets no cookies. No personal data is collected by the website itself.</strong
				>
			</p>
			<p>
				The only contact path on abenerp.com is a <code>mailto:</code> link. Clicking it opens your email
				client — the email is sent from your provider to ours, without traversing abenerp.com infrastructure.
			</p>
		</section>

		<section>
			<h2>What data is processed</h2>
			<ul>
				<li>
					<strong>Page views.</strong> Standard HTTP request metadata (IP address, user-agent, referrer,
					requested URL, timestamp) is briefly visible to our CDN (Amazon CloudFront) to deliver the page.
					If CloudFront access logs are enabled, this metadata is retained for up to 30 days for security
					and debugging purposes. It is not used for analytics, profiling, or marketing.
				</li>
				<li>
					<strong>Email contact.</strong> When you email <code>contact@abenerp.com</code>, the
					contents and your email address are processed by our email provider under that provider's
					privacy policy. We use this data only to respond to your inquiry. Retention is determined
					by the email provider; assume up to 24 months unless you request earlier deletion.
				</li>
			</ul>
		</section>

		<section>
			<h2>Quote requests (Phase 2)</h2>
			<p>
				If you submit the <a href={resolve('/quote')}>quote form</a>, we additionally process the
				following data, solely to respond to your request:
			</p>
			<ul>
				<li>
					<strong>Form fields you provide:</strong> name, email, optional company, optional material preference,
					optional quantity, optional needed-by date, optional notes.
				</li>
				<li>
					<strong>CAD files you upload</strong> and their original filenames, sizes, and submission timestamp.
					CAD files are treated as customer intellectual property and are not shared outside ABENERP's
					quoting workflow.
				</li>
				<li><strong>Consent timestamp.</strong></li>
			</ul>
			<p>
				<strong>Where it lives.</strong> During Phase 2 the data is stored on the ABENERP operator's
				instance; it is not yet integrated into the ABERP order-management system.
				<strong>Retention</strong> is determined by the operator and is documented in the operator
				runbook. <strong>Lawful basis:</strong> pre-contractual steps at your request, GDPR Art. 6(1)(b).
			</p>
			<p>
				To exercise any GDPR right in respect of a quote request, email
				<a href="mailto:contact@abenerp.com">contact@abenerp.com</a> and include the quote reference ID
				shown on screen after submission.
			</p>
		</section>

		<section>
			<h2>What data is NOT processed</h2>
			<ul>
				<li>No cookies, local storage, or session storage are set.</li>
				<li>No third-party analytics, advertising, or tag-management scripts are loaded.</li>
				<li>No fingerprinting, cross-site tracking, or behavioural profiling.</li>
				<li>No newsletter, account system, or persistent identifier of any kind.</li>
			</ul>
		</section>

		<section>
			<h2>Lawful basis (GDPR Art. 6)</h2>
			<ul>
				<li>
					<strong>Server logs:</strong> legitimate interest (security, debugging, fraud prevention) per
					Art. 6(1)(f).
				</li>
				<li>
					<strong>Email correspondence:</strong> performance of pre-contractual steps or legitimate interest
					per Art. 6(1)(b)/(f), depending on the nature of your inquiry.
				</li>
				<li>
					<strong>Quote requests:</strong> performance of pre-contractual steps at your request per Art.
					6(1)(b).
				</li>
			</ul>
		</section>

		<section>
			<h2>Your rights under GDPR</h2>
			<p>
				You have the following rights regarding any personal data we process. To exercise any of
				them, email <a href="mailto:contact@abenerp.com">contact@abenerp.com</a> and we will respond within
				30 days.
			</p>
			<ul>
				<li>
					<strong>Right of access (Art. 15).</strong> You may request a copy of the personal data we hold
					about you, the purposes for which it is processed, and the categories of recipients (Subject
					Access Request — SAR).
				</li>
				<li>
					<strong>Right to rectification (Art. 16).</strong> You may ask us to correct inaccurate or incomplete
					data.
				</li>
				<li>
					<strong>Right to erasure (Art. 17, "right to be forgotten").</strong> You may ask us to delete
					your personal data, subject to legal retention requirements (e.g. tax law) where applicable.
				</li>
				<li>
					<strong>Right to restriction of processing (Art. 18).</strong> You may ask us to stop processing
					your data while a dispute is resolved.
				</li>
				<li>
					<strong>Right to data portability (Art. 20).</strong> Where processing is automated and based
					on consent or contract, you may receive your data in a machine-readable format.
				</li>
				<li>
					<strong>Right to object (Art. 21).</strong> You may object to processing based on legitimate
					interests, including any future direct-marketing use.
				</li>
			</ul>
			<p>
				You also have the right to lodge a complaint with a supervisory authority — in Hungary, the
				Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH).
			</p>
		</section>

		<section>
			<h2>Data controller</h2>
			<address>
				Áben Consulting Kft.<br />
				Tax ID: HU24904362-2-41<br />
				1037 Budapest, Visszatérő köz 6, Hungary<br />
				Email: <a href="mailto:contact@abenerp.com">contact@abenerp.com</a>
			</address>
		</section>

		<section>
			<h2>Changes to this policy</h2>
			<p>
				We will update the "Last reviewed" date above and re-publish the page when the policy
				changes. For material changes affecting your rights, we will note the substance of the
				change at the top of the page for at least 30 days.
			</p>
		</section>

		<footer class="bottom">
			<a href={resolve('/')}>Home</a> · <a href={resolve('/imprint')}>Imprint</a>
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

	ul {
		padding-left: 1.25rem;
		margin: 0 0 1rem;
	}

	li {
		margin-bottom: 0.5rem;
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
		border-radius: 3px;
		font-size: 0.9em;
	}

	address {
		font-style: normal;
		padding: 1rem 1.25rem;
		border-left: 2px solid #d4a574;
		background: rgba(212, 165, 116, 0.05);
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
