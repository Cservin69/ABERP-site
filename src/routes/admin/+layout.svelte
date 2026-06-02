<script lang="ts">
	import { resolve } from '$app/paths';

	let { children, data } = $props();
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="admin-shell">
	<header class="admin-header">
		<a class="brand" href={resolve('/admin/quotes')}>ABENERP admin</a>
		<nav>
			<a href={resolve('/admin/quotes')}>Quotes</a>
			{#if data.authed}
				<form method="post" action={resolve('/admin/logout')} class="logout">
					<button type="submit">Sign out</button>
				</form>
			{/if}
		</nav>
	</header>

	<main class="admin-main">
		{@render children()}
	</main>
</div>

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

	.admin-shell {
		min-height: 100vh;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
	}

	.admin-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid rgba(212, 165, 116, 0.2);
	}

	.brand {
		color: #d4a574;
		text-decoration: none;
		font-weight: 500;
		letter-spacing: 0.05em;
	}

	nav {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	nav a {
		color: rgba(243, 238, 229, 0.8);
		text-decoration: none;
		font-size: 0.9rem;
	}

	nav a:hover {
		color: #d4a574;
	}

	.logout {
		margin: 0;
	}

	.logout button {
		background: transparent;
		border: 1px solid rgba(212, 165, 116, 0.4);
		color: #d4a574;
		padding: 0.35rem 0.75rem;
		border-radius: 2px;
		font-family: inherit;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.logout button:hover {
		background: #d4a574;
		color: #0f1320;
	}

	.admin-main {
		flex: 1;
		padding: 2rem 1.5rem 4rem;
		max-width: 1280px;
		width: 100%;
		box-sizing: border-box;
		margin: 0 auto;
	}
</style>
