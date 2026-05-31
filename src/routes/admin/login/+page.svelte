<script lang="ts">
	let { form } = $props();
	let token = $state('');
	let submitting = $state(false);

	function onSubmit() {
		submitting = true;
	}
</script>

<svelte:head>
	<title>Admin sign-in — Friboard</title>
</svelte:head>

<section class="login">
	<h1>Sign in</h1>
	<p>Enter the operator admin token.</p>

	<form method="post" onsubmit={onSubmit} autocomplete="off">
		<div class="field">
			<label for="token">Admin token</label>
			<input
				id="token"
				name="token"
				type="password"
				required
				autocomplete="current-password"
				bind:value={token}
			/>
		</div>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<button type="submit" class="cta" disabled={submitting || token.length === 0}>
			{submitting ? 'Signing in…' : 'Sign in'}
		</button>
	</form>
</section>

<style>
	.login {
		max-width: 360px;
		margin: 4rem auto 0;
	}

	h1 {
		margin: 0 0 0.5rem;
		font-weight: 400;
		letter-spacing: 0.04em;
	}

	p {
		color: rgba(243, 238, 229, 0.65);
		margin: 0 0 1.5rem;
		font-size: 0.9rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	label {
		font-size: 0.85rem;
		letter-spacing: 0.04em;
	}

	input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.65rem 0.75rem;
		font-family: inherit;
		font-size: 0.95rem;
		color: #f3eee5;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(212, 165, 116, 0.35);
		border-radius: 2px;
	}

	input:focus-visible {
		border-color: #d4a574;
		outline: none;
		background: rgba(255, 255, 255, 0.06);
	}

	.error {
		margin: 0;
		padding: 0.6rem 0.75rem;
		background: rgba(198, 106, 106, 0.12);
		border: 1px solid rgba(198, 106, 106, 0.5);
		color: #e8a8a8;
		font-size: 0.85rem;
	}

	.cta {
		padding: 0.7rem 2rem;
		border: 1px solid #d4a574;
		color: #d4a574;
		background: transparent;
		font-size: 0.95rem;
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
</style>
