<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();

	function formatDate(iso: string): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
	}
</script>

<svelte:head>
	<title>Quotes — ABENERP admin</title>
</svelte:head>

<h1>Quotes</h1>

<div class="filters">
	<a class="chip" class:active={!data.activeStatus} href={resolve('/admin/quotes')}>
		All <span class="count">{data.totalCount}</span>
	</a>
	{#each data.statuses as status (status)}
		<a
			class="chip status-{status}"
			class:active={data.activeStatus === status}
			href={resolve(`/admin/quotes?status=${status}`)}
		>
			{status}
		</a>
	{/each}
</div>

{#if data.quotes.length === 0}
	<p class="empty">
		{#if data.activeStatus}
			No quotes with status <strong>{data.activeStatus}</strong>.
		{:else}
			No quotes yet.
		{/if}
	</p>
{:else}
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Received</th>
					<th>Contact</th>
					<th>Email</th>
					<th>Company</th>
					<th class="num">Files</th>
					<th>Material</th>
					<th class="num">Qty</th>
					<th>Deadline</th>
					<th>Status</th>
				</tr>
			</thead>
			<tbody>
				{#each data.quotes as q (q.id)}
					<tr
						onclick={() => (window.location.href = resolve('/admin/quotes/[id]', { id: q.id }))}
						tabindex="0"
						role="link"
					>
						<td>{formatDate(q.received_at)}</td>
						<td>{q.contact?.name ?? '—'}</td>
						<td>{q.contact?.email ?? '—'}</td>
						<td>{q.contact?.company || '—'}</td>
						<td class="num">{q.files?.length ?? 0}</td>
						<td>{q.request?.material_preference ?? '—'}</td>
						<td class="num">{q.request?.quantity ?? '—'}</td>
						<td>{q.request?.deadline ?? '—'}</td>
						<td><span class="chip status-{q.status}">{q.status}</span></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<style>
	h1 {
		margin: 0 0 1.25rem;
		font-weight: 400;
		letter-spacing: 0.03em;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.7rem;
		border-radius: var(--radius-pill);
		font-size: 0.78rem;
		text-decoration: none;
		text-transform: lowercase;
		border: 1px solid transparent;
		background: rgba(255, 255, 255, 0.06);
		color: rgba(243, 238, 229, 0.8);
		letter-spacing: 0.03em;
	}

	.chip:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.chip.active {
		border-color: #d4a574;
		color: #d4a574;
	}

	.chip .count {
		font-size: 0.7rem;
		opacity: 0.7;
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
	.chip.status-processing {
		background: rgba(94, 156, 211, 0.16);
		color: #88c0e8;
	}
	.chip.status-rejected {
		background: rgba(198, 106, 106, 0.16);
		color: #e8a8a8;
	}
	.chip.status-invoiced {
		background: rgba(170, 124, 196, 0.18);
		color: #c9a8e0;
	}

	.empty {
		color: rgba(243, 238, 229, 0.6);
		font-size: 0.95rem;
	}

	.table-wrap {
		overflow-x: auto;
		border: 1px solid rgba(212, 165, 116, 0.18);
		border-radius: var(--radius-sm);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}

	thead th {
		text-align: left;
		font-weight: 500;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.7rem 0.85rem;
		background: rgba(255, 255, 255, 0.04);
		color: rgba(243, 238, 229, 0.65);
		border-bottom: 1px solid rgba(212, 165, 116, 0.2);
	}

	tbody td {
		padding: 0.65rem 0.85rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
		vertical-align: middle;
	}

	tbody tr {
		cursor: pointer;
		transition: background-color 120ms ease;
	}

	tbody tr:hover,
	tbody tr:focus-visible {
		background: rgba(212, 165, 116, 0.06);
		outline: none;
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
</style>
