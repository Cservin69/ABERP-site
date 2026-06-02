<script lang="ts">
	import { resolve } from '$app/paths';

	let { data, form } = $props();

	// Capture the persisted status at mount time. After a status update we redirect
	// back to this same URL, which remounts the component, so this naturally re-reads
	// the latest value — the captured initial is exactly what we want.
	// svelte-ignore state_referenced_locally
	let newStatus = $state(data.quote.status);
	let notes = $state('');
	let submitting = $state(false);

	function formatDate(iso: string): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	}

	function onSubmit() {
		submitting = true;
	}
</script>

<svelte:head>
	<title>Quote {data.quote.id.slice(0, 8)} — ABENERP admin</title>
</svelte:head>

<a class="back" href={resolve('/admin/quotes')}>← All quotes</a>

<header class="head">
	<div>
		<h1>Quote {data.quote.id.slice(0, 8)}…</h1>
		<p class="meta">Received {formatDate(data.quote.received_at)}</p>
	</div>
	<span class="chip status-{data.quote.status}">{data.quote.status}</span>
</header>

<div class="grid">
	<section class="block">
		<h2>Contact</h2>
		<dl>
			<dt>Name</dt>
			<dd>{data.quote.contact.name}</dd>
			<dt>Email</dt>
			<dd><a href={`mailto:${data.quote.contact.email}`}>{data.quote.contact.email}</a></dd>
			<dt>Company</dt>
			<dd>{data.quote.contact.company || '—'}</dd>
		</dl>
	</section>

	<section class="block">
		<h2>Request</h2>
		<dl>
			<dt>Material</dt>
			<dd>{data.quote.request.material_preference}</dd>
			<dt>Quantity</dt>
			<dd>{data.quote.request.quantity ?? '—'}</dd>
			<dt>Deadline</dt>
			<dd>{data.quote.request.deadline ?? '—'}</dd>
			<dt>Notes</dt>
			<dd class="notes">{data.quote.request.notes || '—'}</dd>
		</dl>
	</section>

	<section class="block files">
		<h2>Files</h2>
		{#if data.files.length === 0}
			<p class="empty">No files attached.</p>
		{:else}
			<ul>
				{#each data.files as f (f.filename)}
					<li>
						<a
							href={resolve('/api/quotes/[id]/files/[filename]', {
								id: data.quote.id,
								filename: f.filename
							})}
							download={f.filename}
							class:missing={!f.exists}
						>
							{f.filename}
						</a>
						<span class="fsize">{formatBytes(f.size_bytes)}</span>
						{#if !f.exists}
							<span class="warn">(missing on disk)</span>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="hint">
				Downloads use the authenticated cookie. Save locally before sharing externally.
			</p>
		{/if}
	</section>

	<section class="block">
		<h2>Update status</h2>
		<form method="post" action="?/status" onsubmit={onSubmit}>
			<div class="field">
				<label for="status">New status</label>
				<select id="status" name="status" bind:value={newStatus}>
					{#each data.statuses as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="notes">Notes (optional)</label>
				<textarea
					id="notes"
					name="notes"
					rows="3"
					maxlength="2000"
					bind:value={notes}
					placeholder="Why this transition?"
				></textarea>
			</div>
			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}
			<button type="submit" class="cta" disabled={submitting || newStatus === data.quote.status}>
				{submitting ? 'Saving…' : 'Apply'}
			</button>
		</form>
	</section>

	<section class="block history">
		<h2>History</h2>
		<ol>
			<li>
				<span class="ts">{formatDate(data.quote.received_at)}</span>
				<span class="transition">submission → <strong>received</strong></span>
			</li>
			{#each data.quote.status_history ?? [] as h, idx (idx)}
				<li>
					<span class="ts">{formatDate(h.at)}</span>
					<span class="transition">{h.from} → <strong>{h.to}</strong></span>
					{#if h.notes}
						<p class="hnote">{h.notes}</p>
					{/if}
				</li>
			{/each}
		</ol>
	</section>
</div>

<style>
	.back {
		color: #d4a574;
		text-decoration: none;
		font-size: 0.85rem;
	}

	.back:hover {
		text-decoration: underline;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1.5rem;
		margin: 1rem 0 2rem;
	}

	h1 {
		margin: 0 0 0.3rem;
		font-weight: 400;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		letter-spacing: 0;
		font-size: 1.4rem;
	}

	.meta {
		margin: 0;
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.85rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.25rem;
	}

	.block {
		padding: 1.25rem;
		border: 1px solid rgba(212, 165, 116, 0.18);
		background: rgba(255, 255, 255, 0.02);
		border-radius: 2px;
	}

	.block.files,
	.block.history {
		grid-column: 1 / -1;
	}

	h2 {
		margin: 0 0 0.85rem;
		font-size: 0.78rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: rgba(243, 238, 229, 0.55);
	}

	dl {
		margin: 0;
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.5rem 1rem;
		font-size: 0.9rem;
	}

	dt {
		color: rgba(243, 238, 229, 0.55);
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding-top: 0.1rem;
	}

	dd {
		margin: 0;
		word-break: break-word;
	}

	dd a {
		color: #d4a574;
	}

	dd.notes {
		white-space: pre-wrap;
		line-height: 1.5;
	}

	.files ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.files li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid rgba(212, 165, 116, 0.18);
		font-size: 0.88rem;
	}

	.files li a {
		color: #d4a574;
		text-decoration: none;
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.files li a:hover {
		text-decoration: underline;
	}

	.files li a.missing {
		color: #c66a6a;
		text-decoration: line-through;
	}

	.fsize {
		color: rgba(243, 238, 229, 0.55);
		font-size: 0.8rem;
		flex-shrink: 0;
	}

	.warn {
		color: #c66a6a;
		font-size: 0.78rem;
	}

	.hint {
		color: rgba(243, 238, 229, 0.55);
		font-size: 0.78rem;
		margin: 0.6rem 0 0;
	}

	.empty {
		color: rgba(243, 238, 229, 0.5);
		font-size: 0.9rem;
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	label {
		font-size: 0.82rem;
		letter-spacing: 0.04em;
	}

	select,
	textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.55rem 0.7rem;
		font-family: inherit;
		font-size: 0.9rem;
		color: #f3eee5;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(212, 165, 116, 0.35);
		border-radius: 2px;
	}

	textarea {
		min-height: 4rem;
		resize: vertical;
	}

	select:focus-visible,
	textarea:focus-visible {
		border-color: #d4a574;
		outline: none;
	}

	.error {
		margin: 0;
		padding: 0.5rem 0.7rem;
		background: rgba(198, 106, 106, 0.12);
		border: 1px solid rgba(198, 106, 106, 0.5);
		color: #e8a8a8;
		font-size: 0.85rem;
	}

	.cta {
		padding: 0.55rem 1.5rem;
		border: 1px solid #d4a574;
		color: #d4a574;
		background: transparent;
		font-size: 0.85rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		cursor: pointer;
		font-family: inherit;
		align-self: flex-start;
	}

	.cta:hover:not(:disabled) {
		background: #d4a574;
		color: #0f1320;
	}

	.cta:disabled {
		opacity: 0.4;
		cursor: not-allowed;
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
		font-size: 0.78rem;
		margin-right: 0.75rem;
	}

	.hnote {
		margin: 0.3rem 0 0;
		color: rgba(243, 238, 229, 0.75);
		font-size: 0.85rem;
		white-space: pre-wrap;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		padding: 0.35rem 0.85rem;
		border-radius: 999px;
		font-size: 0.85rem;
		text-transform: lowercase;
		letter-spacing: 0.05em;
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
