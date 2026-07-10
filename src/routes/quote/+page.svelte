<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Wordmark from '$lib/brand/Wordmark.svelte';
	import MaterialCombobox from '$lib/components/MaterialCombobox.svelte';
	import { buildMaterialOptions } from '$lib/material-options';

	const ACCEPT_EXT = '.step,.stp,.iges,.igs,.stl,.x_t,.x_b,.sldprt,.ipt,.f3d,.dxf,.dwg,.3mf,.obj';
	const MAX_FILES = 10;
	const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
	const NOTES_MAX = 2000;

	type CatalogueMaterial = {
		grade: string;
		display_name: string;
		stock_status: string;
		lead_time_default_days: number;
	};

	let name = $state('');
	let email = $state('');
	let company = $state('');
	let material = $state('unknown');
	// Populated at hydration via /api/catalogue/materials. Empty array =
	// catalogue cache cold OR fetch failed; the hard-coded fallback list stays
	// visible so the form never becomes unusable ([[trust-code-not-operator]]).
	let catalogueMaterials = $state<CatalogueMaterial[]>([]);
	let catalogueLoaded = $state(false);
	// Full alphabetically sorted option list feeding the typeahead combobox:
	// `unknown` + (live catalogue grades OR fallback) + `other`. Rebuilds when the
	// catalogue arrives at hydration.
	const materialOptions = $derived(buildMaterialOptions(catalogueMaterials));

	onMount(async () => {
		try {
			const res = await fetch('/api/catalogue/materials');
			if (!res.ok) return;
			const data = (await res.json()) as { materials?: CatalogueMaterial[] };
			if (Array.isArray(data.materials)) {
				catalogueMaterials = data.materials;
			}
		} catch {
			// Silent — fallback list stays rendered.
		} finally {
			catalogueLoaded = true;
		}
	});
	let quantity = $state<number | null>(null);
	let deadline = $state('');
	let notes = $state('');
	let consent = $state(false);
	let files = $state<File[]>([]);
	let honeypot = $state('');

	let fileInput: HTMLInputElement | undefined = $state();
	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);
	let rejectedFiles = $state<{ filename: string; reason: string }[]>([]);
	let successId = $state<string | null>(null);

	const emailValid = $derived(
		/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.length < 254
	);
	const nameValid = $derived(name.trim().length > 0);
	const filesValid = $derived(files.length > 0 && files.length <= MAX_FILES);
	const totalBytes = $derived(files.reduce((sum, f) => sum + f.size, 0));
	const sizeValid = $derived(totalBytes <= MAX_TOTAL_BYTES);
	const formValid = $derived(nameValid && emailValid && filesValid && sizeValid && consent);

	function onFilesPicked(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files) return;
		const incoming = Array.from(input.files);
		const merged = [...files];
		for (const f of incoming) {
			if (!merged.some((existing) => existing.name === f.name && existing.size === f.size)) {
				merged.push(f);
			}
		}
		files = merged.slice(0, MAX_FILES);
		// User is picking new files — clear any stale per-file rejection notes
		// from the previous attempt.
		rejectedFiles = [];
		input.value = '';
	}

	function removeFile(idx: number) {
		files = files.filter((_, i) => i !== idx);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	}

	async function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!formValid || submitting) return;
		submitting = true;
		errorMessage = null;
		rejectedFiles = [];

		const body = new FormData();
		body.append('name', name.trim());
		body.append('email', email.trim());
		body.append('company', company.trim());
		body.append('material', material);
		if (quantity !== null && quantity !== undefined && quantity > 0) {
			body.append('quantity', String(quantity));
		}
		if (deadline) body.append('deadline', deadline);
		if (notes.trim()) body.append('notes', notes.trim());
		body.append('consent', 'true');
		if (honeypot) body.append('website', honeypot);
		for (const f of files) body.append('files', f);

		try {
			const res = await fetch('/api/quote', { method: 'POST', body });
			const data = (await res.json()) as {
				id?: string;
				error?: string;
				files?: { filename: string; reason: string }[];
			};
			if (data.error === 'invalid_file' && data.files && data.files.length > 0) {
				// Per-file content-validation failure. Render reasons next to the
				// file area (not the top-level error banner) and reset the
				// offending entries so the customer can replace them; the valid
				// files stay so they don't lose their work.
				const rejectedNames = new Set(data.files.map((f) => f.filename));
				rejectedFiles = data.files;
				files = files.filter((f) => !rejectedNames.has(f.name));
				submitting = false;
				return;
			}
			if (!res.ok || !data.id) {
				errorMessage = data.error ?? 'Submission failed. Please try again.';
				submitting = false;
				return;
			}
			successId = data.id;
		} catch {
			errorMessage = 'Network error. Please try again.';
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Get a quote — ABENERP</title>
	<meta
		name="description"
		content="Request a manufacturing quote from ABENERP. Upload your CAD files and we'll get back to you within two business days."
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<main class="page">
	<div class="container">
		<header class="top">
			<a href={resolve('/')} class="back">← ABENERP</a>
			<div class="wordmark-wrap"><Wordmark size={0.5} showMonogram={false} /></div>
			<h1>Get a quote</h1>
			<p class="subtitle">
				Upload your CAD files and tell us what you need. We'll come back within two business days.
			</p>
		</header>

		{#if successId}
			<section class="success" aria-live="polite">
				<h2>Thanks — we have your request.</h2>
				<p>
					Your quote reference is:
					<code class="ref">{successId}</code>
				</p>
				<p>
					We'll email you within two business days at the address you provided. If you need to
					follow up, reply with this reference ID.
				</p>
				<p class="next">
					<a href={resolve('/')} class="cta">Back to home</a>
				</p>
			</section>
		{:else}
			<!-- Progressive enhancement: when JS hydrates, onSubmit calls
			     preventDefault() and submits via fetch() (the nice in-page UX).
			     If hydration fails, the native submit must still reach the API —
			     so the form declares method/action/enctype and every field carries
			     a `name`. Without these a non-hydrated submit would default to
			     GET /quote (the source of the live "POSTs to /" class of bug). -->
			<form
				class="quote-form"
				method="POST"
				action="/api/quote"
				enctype="multipart/form-data"
				onsubmit={onSubmit}
				novalidate
			>
				<!-- Honeypot. Real users never see or focus this; bots that auto-fill
				     every input populate it and the server silently 200-OKs without
				     persisting anything. Server-validated in /api/quote. -->
				<div class="honeypot" aria-hidden="true">
					<label for="website">Website (leave blank)</label>
					<input
						id="website"
						name="website"
						type="text"
						tabindex={-1}
						autocomplete="off"
						bind:value={honeypot}
					/>
				</div>
				<div class="field">
					<label for="name">Your name <span class="req" aria-hidden="true">*</span></label>
					<input
						id="name"
						name="name"
						type="text"
						required
						autocomplete="name"
						bind:value={name}
						class:invalid={name !== '' && !nameValid}
					/>
				</div>

				<div class="field">
					<label for="email">Email <span class="req" aria-hidden="true">*</span></label>
					<input
						id="email"
						name="email"
						type="email"
						required
						autocomplete="email"
						bind:value={email}
						class:invalid={email !== '' && !emailValid}
					/>
				</div>

				<div class="field">
					<label for="company">Company <span class="opt">(optional)</span></label>
					<input
						id="company"
						name="company"
						type="text"
						autocomplete="organization"
						bind:value={company}
					/>
				</div>

				<div class="field">
					<label for="files">
						CAD files <span class="req" aria-hidden="true">*</span>
						<span class="hint"
							>.step .stp .iges .igs .stl .x_t .x_b .sldprt .ipt .f3d .dxf .dwg .3mf .obj — max {MAX_FILES}
							files, 50&nbsp;MB total</span
						>
					</label>
					<input
						id="files"
						name="files"
						type="file"
						multiple
						accept={ACCEPT_EXT}
						bind:this={fileInput}
						onchange={onFilesPicked}
						class:invalid={files.length === 0 ? false : !sizeValid}
					/>
					{#if files.length > 0}
						<ul class="file-list">
							{#each files as f, idx (f.name + f.size)}
								<li>
									<span class="fname">{f.name}</span>
									<span class="fsize">{formatBytes(f.size)}</span>
									<button
										type="button"
										class="remove"
										onclick={() => removeFile(idx)}
										aria-label="Remove {f.name}"
									>
										×
									</button>
								</li>
							{/each}
						</ul>
						<p class="totals" class:over={!sizeValid}>
							{files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
							{#if !sizeValid}
								<span class="warn">— over 50 MB cap, please remove files</span>
							{/if}
						</p>
					{/if}
					{#if rejectedFiles.length > 0}
						<ul class="rejected-list" role="alert" aria-live="polite">
							{#each rejectedFiles as r (r.filename)}
								<li>
									<span class="rfname">{r.filename}</span>
									<span class="rreason">{r.reason}</span>
								</li>
							{/each}
							<li class="rejected-hint">
								Please re-upload {rejectedFiles.length === 1
									? 'a valid CAD file'
									: 'valid CAD files'}
								in place of the {rejectedFiles.length === 1 ? 'one above' : 'ones above'}.
							</li>
						</ul>
					{/if}
				</div>

				<div class="row">
					<div class="field">
						<label for="material">Material <span class="opt">(optional)</span></label>
						<MaterialCombobox
							id="material"
							name="material"
							options={materialOptions}
							bind:value={material}
						/>
						{#if catalogueLoaded && catalogueMaterials.length === 0}
							<p class="catalogue-note">
								List may be limited until our shop sync runs — pick the closest match or
								&ldquo;Other&rdquo; and note specifics below.
							</p>
						{/if}
					</div>

					<div class="field">
						<label for="quantity">Quantity <span class="opt">(optional)</span></label>
						<input
							id="quantity"
							name="quantity"
							type="number"
							min="1"
							step="1"
							inputmode="numeric"
							bind:value={quantity}
						/>
					</div>

					<div class="field">
						<label for="deadline">Needed by <span class="opt">(optional)</span></label>
						<input id="deadline" name="deadline" type="date" bind:value={deadline} />
					</div>
				</div>

				<div class="field">
					<label for="notes">
						Notes <span class="opt">(optional, max {NOTES_MAX} chars)</span>
					</label>
					<textarea id="notes" name="notes" rows="4" maxlength={NOTES_MAX} bind:value={notes}
					></textarea>
					<p class="counter">{notes.length} / {NOTES_MAX}</p>
				</div>

				<div class="field consent">
					<label>
						<input type="checkbox" name="consent" value="true" bind:checked={consent} required />
						I agree my data is processed only to respond to this quote, per the
						<a href={resolve('/privacy')} target="_blank" rel="noopener">Privacy Policy</a>.
						<span class="req" aria-hidden="true">*</span>
					</label>
				</div>

				{#if errorMessage}
					<p class="error" role="alert">{errorMessage}</p>
				{/if}

				<button type="submit" class="cta" disabled={!formValid || submitting}>
					{submitting ? 'Sending…' : 'Submit quote request'}
				</button>
			</form>
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
		max-width: 720px;
		margin: 0 auto;
	}

	.top {
		margin-bottom: 2rem;
	}

	.back {
		display: inline-block;
		color: #d4a574;
		text-decoration: none;
		font-size: 0.85rem;
		letter-spacing: 0.05em;
		margin-bottom: 1.25rem;
	}

	.back:hover,
	.back:focus-visible {
		text-decoration: underline;
		outline: none;
	}

	.wordmark-wrap {
		margin: 0 0 1.5rem;
		max-width: 360px;
	}

	h1 {
		margin: 0 0 0.5rem;
		font-size: clamp(1.5rem, 4vw, 2.25rem);
		font-weight: 400;
		letter-spacing: 0.02em;
	}

	.subtitle {
		margin: 0;
		color: rgba(243, 238, 229, 0.75);
		font-weight: 300;
		font-size: 0.95rem;
	}

	.quote-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.field label {
		font-size: 0.85rem;
		letter-spacing: 0.04em;
		color: #f3eee5;
	}

	.field .req {
		color: #d4a574;
	}

	.field .opt {
		color: rgba(243, 238, 229, 0.5);
		font-size: 0.8rem;
		font-weight: 300;
	}

	.hint {
		display: block;
		font-size: 0.75rem;
		font-weight: 300;
		color: rgba(243, 238, 229, 0.55);
		margin-top: 0.25rem;
	}

	input[type='text'],
	input[type='email'],
	input[type='number'],
	input[type='date'],
	input[type='file'],
	textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.65rem 0.75rem;
		font-family: inherit;
		font-size: 0.95rem;
		color: #f3eee5;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(212, 165, 116, 0.35);
		border-radius: var(--radius-sm);
		transition:
			border-color 160ms ease,
			background-color 160ms ease;
	}

	input:focus-visible,
	textarea:focus-visible {
		border-color: #d4a574;
		outline: none;
		background: rgba(255, 255, 255, 0.06);
	}

	input.invalid {
		border-color: #c66a6a;
	}

	textarea {
		resize: vertical;
		min-height: 6rem;
	}

	input[type='file'] {
		padding: 0.5rem;
		cursor: pointer;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 1rem;
	}

	.file-list {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.file-list li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.4rem 0.6rem;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(212, 165, 116, 0.2);
		border-radius: var(--radius-sm);
		font-size: 0.85rem;
	}

	.fname {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.fsize {
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	.remove {
		background: transparent;
		border: 1px solid rgba(212, 165, 116, 0.4);
		color: #d4a574;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: var(--radius-full);
		cursor: pointer;
		font-size: 1rem;
		line-height: 1;
		padding: 0;
		flex-shrink: 0;
	}

	.remove:hover,
	.remove:focus-visible {
		background: #d4a574;
		color: #0f1320;
		outline: none;
	}

	.totals {
		margin: 0.5rem 0 0;
		font-size: 0.8rem;
		color: rgba(243, 238, 229, 0.65);
	}

	.totals.over {
		color: #c66a6a;
	}

	.totals .warn {
		font-weight: 500;
	}

	.rejected-list {
		list-style: none;
		padding: 0.65rem 0.8rem;
		margin: 0.75rem 0 0;
		background: rgba(198, 106, 106, 0.12);
		border: 1px solid rgba(198, 106, 106, 0.5);
		color: #e8a8a8;
		font-size: 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.rejected-list .rfname {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 500;
		display: inline-block;
		margin-right: 0.5rem;
	}

	.rejected-list .rreason {
		color: rgba(243, 238, 229, 0.85);
	}

	.rejected-list .rejected-hint {
		color: rgba(243, 238, 229, 0.7);
		font-style: italic;
		font-size: 0.8rem;
	}

	.counter {
		margin: 0;
		text-align: right;
		font-size: 0.75rem;
		color: rgba(243, 238, 229, 0.5);
	}

	.catalogue-note {
		margin: 0.35rem 0 0;
		font-size: 0.75rem;
		font-weight: 300;
		color: rgba(243, 238, 229, 0.55);
	}

	.consent label {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		font-size: 0.85rem;
		line-height: 1.45;
		color: rgba(243, 238, 229, 0.85);
		cursor: pointer;
	}

	.consent input[type='checkbox'] {
		flex-shrink: 0;
		margin-top: 0.15rem;
		width: 1rem;
		height: 1rem;
		accent-color: #d4a574;
	}

	.consent a {
		color: #d4a574;
	}

	.error {
		margin: 0;
		padding: 0.65rem 0.8rem;
		background: rgba(198, 106, 106, 0.12);
		border: 1px solid rgba(198, 106, 106, 0.5);
		color: #e8a8a8;
		font-size: 0.9rem;
	}

	/* Honeypot: off-canvas, transparent, untabbable. Hidden from real users
	   and most assistive tech; only naive bots will fill it. */
	.honeypot {
		position: absolute;
		left: -10000px;
		top: auto;
		width: 1px;
		height: 1px;
		overflow: hidden;
		opacity: 0;
		pointer-events: none;
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
		font-family: inherit;
		cursor: pointer;
		transition:
			background-color 160ms ease,
			color 160ms ease,
			opacity 160ms ease;
		align-self: flex-start;
	}

	.cta:hover:not(:disabled),
	.cta:focus-visible:not(:disabled) {
		background: #d4a574;
		color: #0f1320;
		outline: none;
	}

	.cta:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.success {
		padding: 1.5rem;
		border: 1px solid rgba(212, 165, 116, 0.4);
		background: rgba(212, 165, 116, 0.06);
	}

	.success h2 {
		margin: 0 0 0.75rem;
		color: #d4a574;
		font-weight: 400;
		letter-spacing: 0.02em;
	}

	.success p {
		margin: 0 0 0.75rem;
		line-height: 1.55;
	}

	.success .ref {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		background: rgba(0, 0, 0, 0.3);
		border-radius: var(--radius-sm);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9rem;
		color: #f3eee5;
		word-break: break-all;
	}

	.success .next {
		margin-top: 1.5rem;
	}

	.success .cta {
		text-decoration: none;
	}

	@media (max-width: 480px) {
		.page {
			padding: 1.5rem 0.75rem 3rem;
		}
		.cta {
			width: 100%;
			text-align: center;
		}
	}
</style>
